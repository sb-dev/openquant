//! `Ratio`: exact rational arithmetic for price levels (OQ-02 sections 2.2 and 2.5).
//!
//! The expected values come from three places that share no code with the engine: hand
//! derivations written beside the assertion, small-integer reasoning in this file (`i128` with
//! values small enough that nothing overflows), and tables computed once with Python's
//! arbitrary-precision integers for values near the 128-bit limit. The tables are data; the test
//! that reads them is the only code that touches them.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::cmp::Ordering;

use openquant_core::{
    FailureCode,
    numeric::{Decimal, Ratio},
};
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, TestCaseError, TestRng, TestRunner},
};

fn runner(tag: u8, cases: u32) -> TestRunner {
    let mut seed = [0_u8; 32];
    seed[0] = tag;
    seed[31] = 0x71;
    let config = Config {
        cases,
        failure_persistence: None,
        max_shrink_iters: 256,
        ..Config::default()
    };
    TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed))
}

fn check<S: Strategy>(
    tag: u8,
    cases: u32,
    strategy: S,
    test: impl Fn(S::Value) -> Result<(), TestCaseError>,
) where
    S::Value: std::fmt::Debug,
{
    if let Err(error) = runner(tag, cases).run(&strategy, test) {
        panic!("{error}");
    }
}

fn ratio(n: i128, d: i128) -> Ratio {
    Ratio::new(n, d).unwrap()
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The fraction `n / d` reduced with a positive denominator, by i128 reasoning on small terms.
fn reduced(n: i128, d: i128) -> (i128, i128) {
    let g = gcd(n, d).max(1);
    let sign = if d < 0 { -1 } else { 1 };
    (sign * n / g, sign * d / g)
}

fn terms(value: Ratio) -> (i128, i128) {
    (value.numerator(), value.denominator())
}

fn small() -> impl Strategy<Value = (i128, i128)> {
    (-1_000_000_000_i128..=1_000_000_000, 1_i128..=1_000_000_000)
}

// ---------------------------------------------------------------------------------------------
// Construction and the reduction invariant
// ---------------------------------------------------------------------------------------------

#[test]
fn a_ratio_is_always_reduced_with_a_positive_denominator() {
    check(
        1,
        300,
        (
            -1_000_000_000_i128..=1_000_000_000,
            -1_000_000_000_i128..=1_000_000_000,
        ),
        |(n, d)| {
            prop_assume!(d != 0);
            let value = Ratio::new(n, d).unwrap();
            let (num, den) = terms(value);
            prop_assert!(den > 0);
            prop_assert_eq!(gcd(num, den), 1);
            prop_assert_eq!(terms(value), reduced(n, d));
            // The same value however it is written.
            prop_assert_eq!(value, Ratio::new(-n, -d).unwrap());
            prop_assert_eq!(value, Ratio::new(n * 7, d * 7).unwrap());
            Ok(())
        },
    );
}

#[test]
fn construction_hand_cases() {
    assert_eq!(terms(ratio(6, -4)), (-3, 2));
    assert_eq!(terms(ratio(-6, -4)), (3, 2));
    assert_eq!(terms(ratio(0, 5)), (0, 1));
    assert_eq!(terms(ratio(0, -5)), (0, 1));
    assert_eq!(ratio(0, 5), Ratio::ZERO);
    assert_eq!(terms(ratio(7, 1)), (7, 1));
    assert_eq!(ratio(5, 5), Ratio::ONE);
    assert_eq!(Ratio::from_i64(-3), ratio(-3, 1));
    assert_eq!(Ratio::from_u64(u64::MAX), ratio(i128::from(u64::MAX), 1));
    assert!(Ratio::ZERO.is_zero() && !Ratio::ONE.is_zero());
    assert!(ratio(-1, 3).is_negative() && ratio(1, 3).is_positive());
    assert_eq!(ratio(-1, 3).abs(), ratio(1, 3));
    assert_eq!(ratio(-1, 3).negated(), ratio(1, 3));
}

#[test]
fn a_zero_denominator_is_an_internal_failure_and_the_minimum_is_refused() {
    let zero = Ratio::new(1, 0).unwrap_err();
    assert_eq!(zero.code, FailureCode::InvalidInput);
    assert!(zero.detail.contains("internal inconsistency"));
    // i128::MIN has no positive counterpart, so it never appears as a term.
    for (n, d) in [(i128::MIN, 1), (1, i128::MIN), (i128::MIN, i128::MIN)] {
        assert_eq!(
            Ratio::new(n, d).unwrap_err().code,
            FailureCode::ArithmeticOverflow
        );
    }
    // The extreme representable values are fine.
    assert_eq!(terms(ratio(i128::MAX, 1)), (i128::MAX, 1));
    assert_eq!(terms(ratio(-i128::MAX, i128::MAX)), (-1, 1));
    assert_eq!(terms(ratio(1, i128::MAX)), (1, i128::MAX));
}

#[test]
fn a_decimal_converts_exactly() {
    assert_eq!(Ratio::from(Decimal::new(67, 2)), ratio(67, 100));
    assert_eq!(Ratio::from(Decimal::new(500, 2)), ratio(5, 1));
    assert_eq!(Ratio::from(Decimal::new(-5, 1)), ratio(-1, 2));
    assert_eq!(Ratio::from(Decimal::ZERO), Ratio::ZERO);
    assert_eq!(Ratio::from(Decimal::new(0, 8)), Ratio::ZERO);
    // The smallest unit of a decimal: 1e-28.
    let unit = Ratio::from(Decimal::new(1, 28));
    assert_eq!(terms(unit), (1, 10_i128.pow(28)));
    // The largest: 2^96 - 1.
    let max_digits = Decimal::MAX.mantissa();
    assert_eq!(Ratio::from(Decimal::MAX), ratio(max_digits, 1));
    assert_eq!(Ratio::from(Decimal::MIN), ratio(-max_digits, 1));
    check(2, 200, (any::<i64>(), 0_u32..=18), |(mantissa, scale)| {
        let value = Ratio::from(Decimal::new(mantissa, scale));
        prop_assert_eq!(
            value,
            Ratio::new(i128::from(mantissa), 10_i128.pow(scale)).unwrap()
        );
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------

#[test]
fn arithmetic_agrees_with_small_integer_reasoning() {
    check(3, 400, (small(), small()), |((an, ad), (bn, bd))| {
        let (a, b) = (ratio(an, ad), ratio(bn, bd));
        prop_assert_eq!(
            terms(a.add(b).unwrap()),
            reduced(an * bd + bn * ad, ad * bd)
        );
        prop_assert_eq!(
            terms(a.sub(b).unwrap()),
            reduced(an * bd - bn * ad, ad * bd)
        );
        prop_assert_eq!(terms(a.mul(b).unwrap()), reduced(an * bn, ad * bd));
        if bn != 0 {
            prop_assert_eq!(terms(a.div(b).unwrap()), reduced(an * bd, ad * bn));
        }
        // Identities.
        prop_assert_eq!(a.add(Ratio::ZERO).unwrap(), a);
        prop_assert_eq!(a.mul(Ratio::ONE).unwrap(), a);
        prop_assert_eq!(a.sub(a).unwrap(), Ratio::ZERO);
        prop_assert_eq!(a.add(b).unwrap().sub(b).unwrap(), a);
        if bn != 0 {
            prop_assert_eq!(a.mul(b).unwrap().div(b).unwrap(), a);
        }
        Ok(())
    });
}

#[test]
fn the_owner_cases_are_exact_where_a_rounded_mean_is_not() {
    // ATR 0.67 / 3: three times it plus 5 is exactly 5.67, on the price grid.
    let atr = ratio(67, 300);
    let target = ratio(5, 1).add(ratio(3, 1).mul(atr).unwrap()).unwrap();
    assert_eq!(target, ratio(567, 100));
    assert_eq!(target.floor_to(2).unwrap(), Decimal::new(567, 2));
    assert_eq!(target.ceil_to(2).unwrap(), Decimal::new(567, 2));
    assert!(target >= Ratio::from(Decimal::new(567, 2)));
    // ATR 0.68 / 3.
    let atr = ratio(68, 300);
    let target = ratio(5, 1).add(ratio(3, 1).mul(atr).unwrap()).unwrap();
    assert_eq!(target, ratio(568, 100));
    // ATR6 5 / 6 with multiplier 6: the stop is exactly zero.
    let atr = ratio(5, 6);
    assert_eq!(
        ratio(5, 1).sub(ratio(6, 1).mul(atr).unwrap()).unwrap(),
        Ratio::ZERO
    );
    // The mean of closes and back: (a + b + c) / 3 * 3 is the sum.
    let sum = ratio(1000, 100);
    assert_eq!(sum.div(ratio(3, 1)).unwrap().mul(ratio(3, 1)).unwrap(), sum);
    // A split and its reverse.
    let level = ratio(433, 100);
    let third = level.mul(ratio(1, 3)).unwrap();
    assert_eq!(terms(third), (433, 300));
    assert_eq!(third.mul(ratio(3, 1)).unwrap(), level);
}

#[test]
fn a_split_and_its_reverse_return_a_level_to_its_exact_value() {
    check(
        4,
        400,
        (
            small(),
            1_u64..=1000,
            1_u64..=1000,
            1_u64..=1000,
            1_u64..=1000,
        ),
        |((n, d), new1, old1, new2, old2)| {
            let level = ratio(n, d);
            let factor = |new: u64, old: u64| ratio(i128::from(old), i128::from(new));
            let forward = level
                .mul(factor(new1, old1))
                .unwrap()
                .mul(factor(new2, old2))
                .unwrap();
            let back = forward
                .mul(factor(old2, new2))
                .unwrap()
                .mul(factor(old1, new1))
                .unwrap();
            prop_assert_eq!(back, level);
            Ok(())
        },
    );
}

#[test]
fn division_by_zero_is_an_internal_failure_the_caller_decides_first() {
    let failure = ratio(1, 3).div(Ratio::ZERO).unwrap_err();
    assert_eq!(failure.code, FailureCode::InvalidInput);
    assert_eq!(Ratio::ZERO.div(ratio(1, 3)).unwrap(), Ratio::ZERO);
    assert_eq!(ratio(1, 3).div(ratio(-1, 3)).unwrap(), ratio(-1, 1));
}

#[test]
fn overflow_is_a_typed_failure_and_never_a_wrapped_or_rounded_value() {
    let max = ratio(i128::MAX, 1);
    let overflow = |result: Result<Ratio, openquant_core::Failure>, what: &str| {
        let failure = result.expect_err(what);
        assert_eq!(failure.code, FailureCode::ArithmeticOverflow, "{what}");
    };
    overflow(max.add(Ratio::ONE), "MAX + 1");
    overflow(max.negated().sub(Ratio::ONE), "-MAX - 1");
    overflow(max.add(max), "MAX + MAX");
    overflow(max.mul(ratio(2, 1)), "MAX * 2");
    overflow(max.div(ratio(1, 2)), "MAX / (1/2)");
    overflow(ratio(1, i128::MAX).mul(ratio(1, 2)), "(1/MAX) * (1/2)");
    // Two large coprime denominators: the sum needs a denominator beyond 128 bits.
    let a = ratio(1, i128::MAX);
    let b = ratio(1, i128::MAX - 1);
    overflow(a.add(b), "1/MAX + 1/(MAX-1)");
    // A numerator that lands on exactly -2^127 cannot be kept either.
    let half = ratio(-(1_i128 << 126), 1);
    overflow(half.add(half), "-2^126 + -2^126");
    overflow(half.mul(ratio(2, 1)), "-2^126 * 2");
    // The largest results that do fit are returned as they are.
    assert_eq!(max.sub(ratio(1, 1)).unwrap().add(Ratio::ONE).unwrap(), max);
    assert_eq!(
        terms(ratio(1 << 63, 1).mul(ratio(1 << 63, 1)).unwrap()),
        (1 << 126, 1)
    );
    assert_eq!(
        ratio(1, i128::MAX).add(Ratio::ZERO).unwrap(),
        ratio(1, i128::MAX)
    );
}

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

#[test]
fn the_order_agrees_with_cross_multiplication_on_small_terms() {
    check(5, 500, (small(), small()), |((an, ad), (bn, bd))| {
        let (a, b) = (ratio(an, ad), ratio(bn, bd));
        let expected = (an * bd).cmp(&(bn * ad));
        prop_assert_eq!(a.cmp(&b), expected);
        prop_assert_eq!(b.cmp(&a), expected.reverse());
        prop_assert_eq!(a == b, expected == Ordering::Equal);
        // The sign of the difference is the order.
        let difference = a.sub(b).unwrap();
        prop_assert_eq!(difference.numerator().cmp(&0), expected);
        Ok(())
    });
}

#[test]
fn the_order_does_not_overflow_where_the_cross_products_do() {
    // (n+1)/n = 1 + 1/n is larger than (n+2)/(n+1) = 1 + 1/(n+1). With n near 2^127 both cross
    // products are near 2^254.
    let n = i128::MAX - 2;
    let (a, b) = (ratio(n + 1, n), ratio(n + 2, n + 1));
    assert_eq!(a.cmp(&b), Ordering::Greater);
    assert_eq!(b.cmp(&a), Ordering::Less);
    assert!(a > b && b < a && a != b);
    assert_eq!(a.cmp(&a), Ordering::Equal);
    // The same with negative values, which reverses the order.
    let (a, b) = (a.negated(), b.negated());
    assert_eq!(a.cmp(&b), Ordering::Less);
    // Opposite signs and zero.
    assert!(ratio(1, i128::MAX) > Ratio::ZERO);
    assert!(ratio(-1, i128::MAX) < Ratio::ZERO);
    assert!(ratio(-1, i128::MAX) < ratio(1, i128::MAX));
    // Close to the maximum: MAX/1 against (MAX-1)/1 and against a fraction just below.
    assert!(ratio(i128::MAX, 1) > ratio(i128::MAX - 1, 1));
    assert!(ratio(i128::MAX, 2) > ratio(i128::MAX - 2, 2));
    assert!(ratio(i128::MAX, i128::MAX - 1) > ratio(i128::MAX - 1, i128::MAX - 2).negated());
    assert!(ratio(i128::MAX - 1, i128::MAX) > ratio(i128::MAX - 2, i128::MAX - 1));
    // Many random pairs with terms of 80 to 126 bits, ordered by Python's integers.
    for (a, b, c, d, order) in ORDER {
        let want = match *order {
            -1 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        assert_eq!(
            ratio(*a, *b).cmp(&ratio(*c, *d)),
            want,
            "{a}/{b} against {c}/{d}"
        );
        assert_eq!(ratio(*c, *d).cmp(&ratio(*a, *b)), want.reverse());
    }
}

// ---------------------------------------------------------------------------------------------
// Rounding to a grid
// ---------------------------------------------------------------------------------------------

#[test]
fn floor_and_ceil_round_toward_the_infinities_and_agree_on_negative_values() {
    // (numerator, denominator, scale, floor, ceil, half-even), the last three as mantissas.
    let cases: [(i128, i128, u32, i64, i64, i64); 8] = [
        (-1, 3, 0, -1, 0, 0),
        (1, 3, 0, 0, 1, 0),
        (-7, 2, 0, -4, -3, -4),
        (7, 2, 0, 3, 4, 4),
        (-5, 2, 0, -3, -2, -2),
        (-1, 3, 2, -34, -33, -33),
        (1, 3, 2, 33, 34, 33),
        (-567, 100, 2, -567, -567, -567),
    ];
    for (n, d, scale, floor, ceil, even) in cases {
        let value = ratio(n, d);
        let on_grid = |mantissa: i64| Decimal::new(mantissa, scale);
        assert_eq!(
            value.floor_to(scale).unwrap(),
            on_grid(floor),
            "floor {n}/{d}"
        );
        assert_eq!(value.ceil_to(scale).unwrap(), on_grid(ceil), "ceil {n}/{d}");
        assert_eq!(
            value.half_even_to(scale).unwrap(),
            on_grid(even),
            "even {n}/{d}"
        );
        // The result carries the scale it was asked for.
        assert_eq!(value.floor_to(scale).unwrap().scale(), scale);
    }
    // Ties go to the even digit, for both signs: 0.5 -> 0, 1.5 -> 2, 2.5 -> 2, -0.5 -> 0, -1.5 ->
    // -2, -2.5 -> -2; 0.125 -> 0.12, 0.135 -> 0.14.
    for (n, d, scale, mantissa) in [
        (1, 2, 0, 0),
        (3, 2, 0, 2),
        (5, 2, 0, 2),
        (-1, 2, 0, 0),
        (-3, 2, 0, -2),
        (-5, 2, 0, -2),
        (1, 8, 2, 12),
        (27, 200, 2, 14),
        (-1, 8, 2, -12),
        (-27, 200, 2, -14),
    ] {
        assert_eq!(
            ratio(n, d).half_even_to(scale).unwrap(),
            Decimal::new(mantissa, scale),
            "{n}/{d}"
        );
    }
    // A value on the grid is its own floor and ceil, at any scale at or beyond its own.
    for scale in [2, 5, 28] {
        let value = ratio(567, 100);
        assert_eq!(value.floor_to(scale).unwrap(), Decimal::new(567, 2));
        assert_eq!(value.ceil_to(scale).unwrap(), Decimal::new(567, 2));
    }
    assert_eq!(Ratio::ZERO.floor_to(2).unwrap(), Decimal::ZERO);
}

#[test]
fn rounding_agrees_with_small_integer_reasoning() {
    check(6, 500, (small(), 0_u32..=8), |((n, d), scale)| {
        let power = 10_i128.pow(scale);
        let floor = (n * power).div_euclid(d);
        let remainder = (n * power).rem_euclid(d);
        let value = ratio(n, d);
        prop_assert_eq!(value.floor_to(scale).unwrap().mantissa(), floor);
        prop_assert_eq!(
            value.ceil_to(scale).unwrap().mantissa(),
            floor + i128::from(remainder != 0)
        );
        let even = match (2 * remainder).cmp(&d) {
            Ordering::Less => floor,
            Ordering::Greater => floor + 1,
            Ordering::Equal => floor + (floor & 1),
        };
        prop_assert_eq!(value.half_even_to(scale).unwrap().mantissa(), even);
        // floor <= value <= ceil, and half-even is one of them.
        let (lo, hi) = (
            value.floor_to(scale).unwrap(),
            value.ceil_to(scale).unwrap(),
        );
        prop_assert!(Ratio::from(lo) <= value && value <= Ratio::from(hi));
        Ok(())
    });
}

#[test]
fn rounding_is_exact_beyond_128_bits_of_intermediate_product() {
    let mut seen_none = false;
    for (n, d, scale, floor, ceil, even) in ROUNDING.iter().chain(TIES) {
        let value = ratio(*n, *d);
        for (got, want, what) in [
            (value.floor_to(*scale), floor, "floor"),
            (value.ceil_to(*scale), ceil, "ceil"),
            (value.half_even_to(*scale), even, "half-even"),
        ] {
            match want {
                Some(mantissa) => {
                    let got = got.unwrap_or_else(|f| panic!("{what} {n}/{d}: {f}"));
                    assert_eq!(got.mantissa(), *mantissa, "{what} {n}/{d} at {scale}");
                    assert_eq!(got.scale(), *scale);
                }
                None => {
                    seen_none = true;
                    let failure = got.expect_err("the digits do not fit a decimal");
                    assert_eq!(failure.code, FailureCode::ArithmeticOverflow);
                }
            }
        }
    }
    assert!(seen_none, "the table must include a value that overflows");
    // A scale above 28 is refused, not rounded.
    assert_eq!(
        ratio(1, 3).floor_to(29).unwrap_err().code,
        FailureCode::ArithmeticOverflow
    );
    // The largest denominator, at the finest grid.
    let value = ratio(1, i128::MAX);
    assert_eq!(value.floor_to(28).unwrap(), Decimal::ZERO);
    assert_eq!(value.ceil_to(28).unwrap(), Decimal::new(1, 28));
    let value = ratio(i128::MAX - 1, i128::MAX);
    assert_eq!(
        value.floor_to(28).unwrap().to_string(),
        "0.9999999999999999999999999999"
    );
    assert_eq!(value.ceil_to(28).unwrap(), Decimal::ONE);
}

// ---------------------------------------------------------------------------------------------
// Decimal forms
// ---------------------------------------------------------------------------------------------

#[test]
fn only_a_value_that_terminates_within_28_digits_has_an_exact_decimal() {
    let exact = |n, d| ratio(n, d).to_decimal_exact();
    assert_eq!(exact(1, 2), Some(Decimal::new(5, 1)));
    assert_eq!(exact(5, 1), Some(Decimal::from(5)));
    assert_eq!(exact(-7, 4), Some(Decimal::new(-175, 2)));
    assert_eq!(exact(0, 1), Some(Decimal::ZERO));
    assert_eq!(exact(1, 3), None);
    assert_eq!(exact(1, 7), None);
    assert_eq!(exact(5, 6), None);
    // 28 fractional digits terminate; 29 do not fit a decimal.
    assert_eq!(exact(1, 1 << 28).unwrap().scale(), 28);
    assert_eq!(exact(1, 1 << 29), None);
    // An integer beyond 96 bits has no decimal.
    assert_eq!(exact(i128::MAX, 1), None);
    // The result is normalised: no trailing zeros.
    assert_eq!(exact(10, 1).unwrap().scale(), 0);
    assert_eq!(exact(25, 10).unwrap().scale(), 1);
}

#[test]
fn the_display_decimal_is_exact_when_it_terminates_and_otherwise_the_widest_rounding() {
    // Hand cases: the most digits a decimal carries is 28 (29 with a leading digit below 8).
    let shown = |n, d| ratio(n, d).to_display_decimal().unwrap().to_string();
    assert_eq!(shown(1, 3), "0.3333333333333333333333333333");
    assert_eq!(shown(2, 3), "0.6666666666666666666666666667");
    assert_eq!(shown(-1, 3), "-0.3333333333333333333333333333");
    assert_eq!(shown(5, 3), "1.6666666666666666666666666667");
    assert_eq!(shown(100, 3), "33.333333333333333333333333333");
    assert_eq!(shown(55, 6), "9.166666666666666666666666667");
    assert_eq!(shown(5, 6), "0.8333333333333333333333333333");
    assert_eq!(shown(17, 75), "0.2266666666666666666666666667");
    assert_eq!(shown(1, 2), "0.5");
    assert_eq!(shown(5, 1), "5");
    // The table, from Python's integers.
    for (n, d, scale, mantissa) in DISPLAY {
        let got = ratio(*n, *d).to_display_decimal().unwrap();
        assert_eq!(got.mantissa(), *mantissa, "{n}/{d}");
        assert_eq!(got.scale(), *scale, "{n}/{d}");
    }
    // An integer part beyond 96 bits cannot be shown.
    assert_eq!(
        ratio(i128::MAX, 2).to_display_decimal().unwrap_err().code,
        FailureCode::ArithmeticOverflow
    );
}

#[test]
fn the_display_decimal_is_what_the_decimal_division_of_earlier_builds_produced() {
    // Earlier builds divided two decimals and kept what the division returned. A value shown in a
    // result must read the same, so that no stored result changes.
    check(
        7,
        600,
        (
            -1_000_000_000_000_i64..=1_000_000_000_000,
            1_i64..=1_000_000,
            0_u32..=4,
        ),
        |(n, d, scale)| {
            let quotient = Decimal::new(n, scale) / Decimal::from(d);
            let value = Ratio::from(Decimal::new(n, scale))
                .div(Ratio::from_i64(d))
                .unwrap();
            prop_assert_eq!(value.to_display_decimal().unwrap(), quotient);
            Ok(())
        },
    );
}

// ---------------------------------------------------------------------------------------------
// Text: display and wire
// ---------------------------------------------------------------------------------------------

#[test]
fn display_is_canonical_whatever_the_path_to_the_value() {
    assert_eq!(Ratio::ZERO.to_string(), "0");
    assert_eq!(ratio(5, 1).to_string(), "5");
    assert_eq!(ratio(-5, 1).to_string(), "-5");
    assert_eq!(ratio(1, 2).to_string(), "0.5");
    assert_eq!(ratio(567, 100).to_string(), "5.67");
    assert_eq!(ratio(1, 3).to_string(), "1/3");
    assert_eq!(ratio(-1, 3).to_string(), "-1/3");
    assert_eq!(ratio(-35, 1).to_string(), "-35");
    assert_eq!(ratio(55, 6).to_string(), "55/6");
    assert_eq!(format!("{:?}", ratio(1, 3)), "Ratio(1/3)");
    // 0.67 / 3 * 3 is 0.67 however the intermediate fractions look.
    let value = ratio(67, 100)
        .div(ratio(3, 1))
        .unwrap()
        .mul(ratio(3, 1))
        .unwrap();
    assert_eq!(value.to_string(), "0.67");
    // A decimal with trailing zeros prints without them.
    assert_eq!(Ratio::from(Decimal::new(35_900, 3)).to_string(), "35.9");
}

#[test]
fn the_wire_form_round_trips_and_follows_the_canonical_rule() {
    check(
        8,
        500,
        (
            -1_000_000_000_000_i128..=1_000_000_000_000,
            1_i128..=1_000_000_000_000,
        ),
        |(n, d)| {
            let value = ratio(n, d);
            let text = value.to_wire().unwrap();
            // A fraction exactly when no decimal form exists.
            prop_assert_eq!(text.contains('/'), value.to_decimal_exact().is_none());
            prop_assert_eq!(Ratio::from_wire(&text).unwrap(), value);
            // The wire text is the display text.
            prop_assert_eq!(text, value.to_string());
            Ok(())
        },
    );
    for (text, value) in [
        ("0", Ratio::ZERO),
        ("5", ratio(5, 1)),
        ("-5", ratio(-5, 1)),
        ("0.5", ratio(1, 2)),
        ("5.67", ratio(567, 100)),
        ("1/3", ratio(1, 3)),
        ("-1/3", ratio(-1, 3)),
        ("17/75", ratio(17, 75)),
        ("341/75", ratio(341, 75)),
        ("1/536870912", ratio(1, 1 << 29)),
        (
            "170141183460469231731687303715884105727/3",
            ratio(i128::MAX, 3),
        ),
        (
            "1/170141183460469231731687303715884105727",
            ratio(1, i128::MAX),
        ),
    ] {
        assert_eq!(Ratio::from_wire(text).unwrap(), value, "{text}");
        assert_eq!(value.to_wire().unwrap(), text, "{text}");
    }
    // The reader accepts a decimal with trailing zeros, as any decimal on the wire.
    assert_eq!(Ratio::from_wire("102.00").unwrap(), ratio(102, 1));
}

#[test]
fn the_wire_reader_rejects_every_non_canonical_or_malformed_form() {
    for text in [
        "2/4",
        "6/9",
        "5/1",
        "-5/1",
        "1/2",
        "-3/4",
        "7/5",
        "1/0",
        "0/5",
        "0/1",
        "-0/5",
        "01/3",
        "1/03",
        "00/3",
        "1/",
        "/3",
        "/",
        "+1/3",
        "1/+3",
        "1e3",
        "1/3e2",
        "1e3/7",
        "1/-3",
        "--1/3",
        "1.5/3",
        "1/3.5",
        "1/3/4",
        " 1/3",
        "1/3 ",
        "1 /3",
        "1/ 3",
        "",
        "-",
        "abc",
        "١/٣",
        "170141183460469231731687303715884105729/3",
        "-170141183460469231731687303715884105728/3",
        "1/170141183460469231731687303715884105728",
        "99999999999999999999999999999999999999999999999999/3",
        "1/3000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "1.00000000000000000000000000001",
        "79228162514264337593543950336",
    ] {
        let failure = Ratio::from_wire(text).expect_err(text);
        assert_eq!(failure.code, FailureCode::InvalidDecimal, "{text:?}");
    }
}

#[test]
fn an_integer_too_large_for_a_decimal_has_no_wire_form() {
    // A fraction needs a denominator above 1, and the integer is beyond 96 bits: refused with a
    // typed failure, never written in a form the reader rejects.
    let failure = ratio(i128::MAX, 1).to_wire().unwrap_err();
    assert_eq!(failure.code, FailureCode::ArithmeticOverflow);
    assert_eq!(ratio(i128::MAX, 1).to_string(), format!("{}/1", i128::MAX));
    // A fraction with a large part writes fine.
    assert!(ratio(i128::MAX, 2).to_wire().is_ok());
}

/// A rounding case: numerator, denominator, scale, then the floor, ceil and half-even mantissas.
/// A mantissa is `None` when it needs more than the 96 bits of a decimal.
type Rounding = (i128, i128, u32, Option<i128>, Option<i128>, Option<i128>);

// (numerator, denominator, scale, floor, ceil, half-even): each mantissa is Some when it
// fits the 96 digits of a decimal and None when it does not.
#[rustfmt::skip]
const ROUNDING: &[Rounding] = &[
    (35796334941090959834363527918, 161704690444432845057019307, 20, Some(22136856291989737347562), Some(22136856291989737347563), Some(22136856291989737347562)),
    (23665741539895364827610212323, 484615078536466407173137223, 8, Some(4883410068), Some(4883410069), Some(4883410069)),
    (-388034233672538002459620672743193024, 965052857531515453042020136199491, 8, Some(-40208599006), Some(-40208599005), Some(-40208599005)),
    (-4782775311610757438, 128725362313671405231, 2, Some(-4), Some(-3), Some(-4)),
    (2866837160752812125105322291, 1085444861706841551680228915, 12, Some(2641163325647), Some(2641163325648), Some(2641163325648)),
    (541716487934982271504622092963618, 658683695634683011464858855341, 8, Some(82242279796), Some(82242279797), Some(82242279796)),
    (383099088409849434264363658574254352, 1113371365060948270762655436849419827, 2, Some(34), Some(35), Some(34)),
    (1634863160779618853965622234781964394, 10659132360810611487346499764658592279, 20, Some(15337675764214732880), Some(15337675764214732881), Some(15337675764214732880)),
    (-607347205672664121692026352, 839319187370822361238500967, 20, Some(-72361887445369464911), Some(-72361887445369464910), Some(-72361887445369464910)),
    (-62763669879639898678816, 194076882960119133863, 28, None, None, None),
    (24569819794692162954236794126936283324, 68814251767558900258913661351192928055, 28, Some(3570455125732415801654130696), Some(3570455125732415801654130697), Some(3570455125732415801654130696)),
    (2309731026284018509998335584038455698, 1237293604090259421829906364854923659, 2, Some(186), Some(187), Some(187)),
    (-10641743605489572688015618202681452073, 14257950630084161926219724992986513, 28, None, None, None),
    (139283347158559600472324323974163826840, 174653281385431488619305150479907457, 2, Some(79748), Some(79749), Some(79748)),
    (6719283413330547276600215339, 28123779151360276340557821, 8, Some(23891822564), Some(23891822565), Some(23891822565)),
    (877521900170579089618083187711920, 1153167495233422987779056224853777, 8, Some(76096655), Some(76096656), Some(76096656)),
    (-2914998302095241595233359670395439477, 14146595395176745511888271679241412933, 2, Some(-21), Some(-20), Some(-21)),
    (-2096282953362982651767686857869615666, 907692898319156241219373110091582715, 12, Some(-2309462767909), Some(-2309462767908), Some(-2309462767908)),
    (-429549371525689506711579871898, 954480951877553238550377465, 0, Some(-451), Some(-450), Some(-450)),
    (34364697383236569687071318671978913, 195762974925701586692362182166691, 0, Some(175), Some(176), Some(176)),
    (45755686079645549106308, 50817089761597702967, 2, Some(90039), Some(90040), Some(90040)),
    (14743653647844554344533694600937464566, 50068417971405480945478066952824986235, 0, Some(0), Some(1), Some(0)),
    (165884544638071868593466129084, 55989141078849627879368299215, 0, Some(2), Some(3), Some(3)),
    (-93068848141331390203871997379435522, 535880748431336275910287652857791583, 20, Some(-17367455056702140817), Some(-17367455056702140816), Some(-17367455056702140817)),
    (543334723653516414122542969, 214293452992558784221807315, 20, Some(253547047782361973068), Some(253547047782361973069), Some(253547047782361973068)),
    (2658188202793145473070206848081, 1220347596756928336602349112327, 0, Some(2), Some(3), Some(2)),
    (453344154880969166724942847162951685, 751557811972794227460304036815223, 2, Some(60320), Some(60321), Some(60321)),
    (208912999639560449757669341027554, 472306326677706068145581270701, 20, Some(44232521954362721023373), Some(44232521954362721023374), Some(44232521954362721023374)),
    (-763063309359302785577465433892, 1018973290636885074427728217, 8, Some(-74885506458), Some(-74885506457), Some(-74885506457)),
    (-135929293229338404647734651271, 66722434672587021864681828541, 12, Some(-2037235210262), Some(-2037235210261), Some(-2037235210261)),
    (-918701749319548059790679, 950560848751524928873, 8, Some(-96648389267), Some(-96648389266), Some(-96648389267)),
    (-23636393847108311899306, 46357022547336424033, 28, None, None, None),
    (-212977105632028358735936048148, 72482620252387109539212535805, 0, Some(-3), Some(-2), Some(-3)),
    (-12010256405167992642876, 119680218036685468255, 28, None, None, None),
    (33547300437607032781842224215987, 780726623923425215534963978297, 0, Some(42), Some(43), Some(43)),
    (922246170415587921584273193391553764, 1191548610101428186284036721325269, 8, Some(77398954822), Some(77398954823), Some(77398954822)),
];

// (a, b, c, d, order of a/b against c/d): -1, 0 or 1.
#[rustfmt::skip]
const ORDER: &[(i128, i128, i128, i128, i8)] = &[
    (193116766127923568257783259334551311, 207809738490952139437043669026914693, 10262709980387003605014161186577997648, 11043531434344648417567149602913030229, 1),
    (425902747411331853609111276707103139, 302592456879220004096506971861729569, 1732278282234658488190100921288, 883304985716898589820833274091, -1),
    (-29026911492641351581851323924, 165727307440908693494767323803, -38708957642099827493916779365530652045, 78692997400639551751426344837118533143, 1),
    (-356377600138007300485424580127, 409661522704798257167381071239, -689720752886725536872307455403, 792844594495438319937443060089, 1),
    (-1117798967804464088787860343731438738, 815965429792364038239833756945924591, -122651904127048048803992538804, 71778671699720962816408223689, 1),
    (529172364915336378640028951245, 395595552658169151377651091401, 22003692472559045811489, 13977249231146445568361, -1),
    (235637546485026106568692, 389466701932857078591549, -994362925419898921920913, 614632596780326347918043, 1),
    (137639808595279379412631, 70253481959242550270267, 91847871262835393843469818351824675231, 46880570618431853888643750719309689433, 1),
    (262717109063967681562664633176449283, 178814504435162069252140934092821823, 1138450875863560775087443667244226462, 639448364712582970501610738581379679, -1),
    (188686902662484798515110507147, 141659038318785627660983982877, 37094650938019801249061212547368631155, 27849270428962821929795106406528594819, 1),
    (14267220209831570142032, 54946794325570488554617, 10149079049129009891368685175430975756, 5548064655656833224694088190510120283, -1),
    (-1708063136528811888161013300933267310, 1024274695617712251700199426150791999, 1480570605904779579060169501704, 777139618320453229333493355203, -1),
    (-1210294330506217365107085263717807028, 1279113734608002141277553927857876327, -76667987977293956577735000996, 226436043934714013127331540903, -1),
    (-67366542655398595918838, 154007296268711543876069, 725195893605998997610871757241, 1204067102188082857547020011703, -1),
    (-1980861922029650132764409259312, 1096932160534875960497799087295, 370323683567380009404937, 387690443762417523709601, -1),
    (30444415282418584388128342316693717101, 21219666403363870382030771102019912467, -286089901674923500192687320413875730, 232196653197031622802809380523333317, 1),
    (22688097556646415814725199420357770845, 20244715928578977470145564575735922023, 745780965645933602639198539946, 665464513132802945231004514311, 1),
    (-31531211608305073260388678843126268, 170846772964893687494877984396889799, -843882119286427492988551, 827398836561389063574951, 1),
    (855901946597571935649858616497, 433928157471376848001344996589, 268647731124368269498560205628, 136199964772920033889151485123, 1),
    (-331482258983810856238877849374666306, 1082914495416977101515523587429170351, -213881646940554693688351077178, 698726793058613187641553930807, 1),
    (53604201783297966704766135859, 407617445306973456926638135495, 6866889990285095619128416728125805508, 52217252788496381475111762931023988833, 1),
    (-489607852208691919344528198873853966, 1052227328970853963538547328199336521, -47095123224498100270312749824253486, 101213196427545224517535672523865239, -1),
    (-90533582414828041582768898739766906507, 58785235092315113680834992787748798159, 55163613039784682998201765449, 607971563508644095489584844435, -1),
    (1660489513370171194058381172, 3385507029894726952111313971, 19213181411767215427521361597089372610, 39173003028583345880245715075168748733, 1),
    (-371190012151954990758542, 210683116941572407818479, -926263361115887964659395573221, 497090201337248375534832799085, 1),
    (-54479433731804127802399797338044599425, 31243144178436212832639804000758587701, -692617555049370060572142, 397205856423773060522705, 1),
    (-11605248896558222810296669761787631841, 16003134839152481146881021276126613331, -73840514545197742694363, 101822866652144887856219, 1),
    (-104046184197966879424707164294329054815, 56714758597972300257420276397212851863, -1492742104178148254886956120625874052, 813682008043762651728696505081577909, 1),
    (-189073959637636844074979, 130743117299923899296873, -68103210251876380571758358573730826108, 47092820309719839034669164433539041929, 1),
    (300826479152178611163277, 498369173865793584651861, 109837254566532457424639922967, 181963708687753713906385056753, 1),
    (686976778268964657986741, 546065929978669795995815, -702132951458348621195608, 496848470526961032307791, 1),
    (866902807808673149688882943953842514, 928250571184372250866902672039758471, 266193959496358128081970315344711668, 285031600685342667260525698810723043, 1),
    (1377280529875068322269029165400698789, 1313283810231460468636274459921420193, 59596075314172106219019922849704310232, 56826883968610595349490560181751882281, -1),
    (1752853634973631161372096826978480302, 895316116645599160684370388100148969, 20112517417604608465601824040343362812, 64609873522381195122953859028768632727, 1),
    (-282830043796535116115741, 153546604272599740974399, -1358665090084483870198324408633, 737610503204801532244902172943, 1),
    (-249499365892577358524999828456057824, 191287398383396919304620303798078729, -215118397757894232581267116976, 178039813761105206654366156487, -1),
];

// (numerator, denominator, scale, mantissa) of the display decimal of a value that does not
// terminate: the most digits (at most 28 after the point) that fit 96 bits, half-even.
#[rustfmt::skip]
const DISPLAY: &[(i128, i128, u32, i128)] = &[
    (19123004427255036323, 997, 12, 19180546065451390494483450351),
    (39162141542392584994, 11, 10, 35601946856720531812727272727),
    (20519117147568729007209951, 1099511627777, 15, 18662028330754826109913843697),
    (-982224190440, 13, 18, -75555706956923076923076923077),
    (-345806680926732, 1099511627777, 26, -31450934414025822721292546864),
    (-2484634187143222895393294662, 225, 3, -11042818609525435090636865164),
    (75481137421, 21, 19, 35943398771904761904761904762),
    (-20714170512393262742, 7000021, 16, -29591583385811646482203410533),
    (-7814563, 13, 23, -60112023076923076923076923077),
    (413031219553089177677381857, 15, 3, 27535414636872611845158790467),
    (909837615232033, 18, 15, 50546534179557388888888888889),
    (-48488845479681067525, 9, 10, -53876494977423408361111111111),
    (-921337857919214, 111, 15, -8300341062335261261261261261),
    (-472968100789387, 39, 15, -12127387199727871794871794872),
    (66038968811581512347, 21, 10, 31447128005515005879523809524),
    (-245731643695413, 13, 15, -18902434130416384615384615385),
    (573, 997, 28, 5747241725175526579739217653),
    (795781402259, 7000021, 23, 11368271641742217630489965673),
    (-1062897618466756368101341439, 1050, 4, -10122834461588155886679442276),
    (88891448435376053671, 1000003, 14, 8889118176183076817869546391),
    (-6374627684523338464576361480, 91, 3, -70050853676080642467872104176),
    (3947917492609902444700259699, 7, 2, 56398821322998606352860852843),
    (-10572242335435702143646412, 15, 5, -70481615569571347624309413333),
    (-7289301430810304718696299767, 900, 3, -8099223812011449687440333074),
    (-586811208547, 75, 19, -78241494472933333333333333333),
    (98837532, 707, 23, 13979848939179632248939179632),
    (-639, 997, 28, -6409227683049147442326980943),
    (-13258176913883, 18, 17, -73656538410461111111111111111),
    (9971735254638595739293783715, 1099511627777, 12, 9069240381567875828215815854),
    (49232014734758314012, 77, 11, 63937681473712096119480519481),
];

// Exact ties at scale 28 whose product with 10^28 needs more than 128 bits: n / (2 * 10^28) with
// an odd n that no factor of 10 reduces, so the value lies exactly half way between two grid
// points. The even neighbour wins for half-even, for both signs. The last two rows are values
// exactly on the grid (r / 10^22), where floor, ceil and half-even agree and no remainder is left.
#[rustfmt::skip]
const TIES: &[Rounding] = &[
    (12345678901234567890123456789, 20000000000000000000000000000, 28, Some(6172839450617283945061728394), Some(6172839450617283945061728395), Some(6172839450617283945061728394)),
    (12345678901234567890123456791, 20000000000000000000000000000, 28, Some(6172839450617283945061728395), Some(6172839450617283945061728396), Some(6172839450617283945061728396)),
    (-12345678901234567890123456789, 20000000000000000000000000000, 28, Some(-6172839450617283945061728395), Some(-6172839450617283945061728394), Some(-6172839450617283945061728394)),
    (-12345678901234567890123456791, 20000000000000000000000000000, 28, Some(-6172839450617283945061728396), Some(-6172839450617283945061728395), Some(-6172839450617283945061728396)),
    (70000000000000000000000000001, 20000000000000000000000000000, 28, Some(35000000000000000000000000000), Some(35000000000000000000000000001), Some(35000000000000000000000000000)),
    (5687718809495529127681, 10000000000000000000000, 28, Some(5687718809495529127681000000), Some(5687718809495529127681000000), Some(5687718809495529127681000000)),
    (441596824277242355689, 10000000000000000000000, 28, Some(441596824277242355689000000), Some(441596824277242355689000000), Some(441596824277242355689000000)),
];
