//! `Q`, the exact rational of derived evidence, against an independent reference.
//!
//! The reference uses `i128` cross-multiplication and an integer half-even rounding written here,
//! so it shares no code with `Q`. The ranges keep every reference intermediate inside 128 bits,
//! which the unbounded `Q` does not need. A second group of tests pins the cases that the
//! generators reach only rarely: ties at every digit, sign handling and values beyond 128 bits.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::cmp::Ordering;

use num_bigint::BigInt;
use openquant_core::exact::Q;
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed},
};

fn config(seed: u64) -> ProptestConfig {
    Config {
        cases: 2_000,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(seed),
        max_shrink_iters: 256,
        ..Config::default()
    }
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// `n / d` reduced with a positive denominator, as text in the format of `Q::to_string`.
fn reference_text(n: i128, d: i128) -> String {
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    let g = gcd(n, d).max(1);
    let (n, d) = (n / g, d / g);
    if n == 0 {
        "0".to_owned()
    } else if d == 1 {
        n.to_string()
    } else {
        format!("{n}/{d}")
    }
}

fn q(n: i128, d: i128) -> Q {
    Q::new(BigInt::from(n), BigInt::from(d)).unwrap()
}

/// Half-even rounding of `n / d` to `scale` fractional digits with integer arithmetic only.
fn reference_fixed(n: i128, d: i128, scale: u32) -> String {
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    let negative = n < 0;
    let scaled = n.abs() * 10_i128.pow(scale);
    let mut quotient = scaled / d;
    let remainder = scaled % d;
    if 2 * remainder > d || (2 * remainder == d && quotient % 2 == 1) {
        quotient += 1;
    }
    let digits = format!("{:0>width$}", quotient, width = scale as usize + 1);
    let (whole, fraction) = digits.split_at(digits.len() - scale as usize);
    let sign = if negative && quotient != 0 { "-" } else { "" };
    if scale == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

proptest! {
    #![proptest_config(config(0x51_u64))]

    #[test]
    fn addition_subtraction_and_multiplication_match_cross_multiplication(
        n1 in -1_000_000_i128..1_000_000,
        d1 in 1_i128..1_000_000,
        n2 in -1_000_000_i128..1_000_000,
        d2 in 1_i128..1_000_000,
    ) {
        let (a, b) = (q(n1, d1), q(n2, d2));
        prop_assert_eq!((&a + &b).to_string(), reference_text(n1 * d2 + n2 * d1, d1 * d2));
        prop_assert_eq!((&a - &b).to_string(), reference_text(n1 * d2 - n2 * d1, d1 * d2));
        prop_assert_eq!((&a * &b).to_string(), reference_text(n1 * n2, d1 * d2));
    }

    #[test]
    fn division_and_order_match_cross_multiplication(
        n1 in -1_000_000_i128..1_000_000,
        d1 in 1_i128..1_000_000,
        n2 in -1_000_000_i128..1_000_000,
        d2 in 1_i128..1_000_000,
    ) {
        let (a, b) = (q(n1, d1), q(n2, d2));
        let expected: Ordering = (n1 * d2).cmp(&(n2 * d1));
        prop_assert_eq!(a.cmp(&b), expected);
        prop_assert_eq!(a == b, expected == Ordering::Equal);
        if n2 == 0 {
            prop_assert!(a.checked_div(&b).is_err());
        } else {
            prop_assert_eq!(a.checked_div(&b).unwrap().to_string(), reference_text(n1 * d2, d1 * n2));
        }
    }

    #[test]
    fn rounding_matches_the_integer_half_even_reference(
        n in -1_000_000_000_000_i128..1_000_000_000_000,
        d in 1_i128..1_000_000,
        scale in 0_u32..9,
    ) {
        prop_assert_eq!(q(n, d).to_fixed(scale).unwrap(), reference_fixed(n, d, scale));
    }

    #[test]
    fn a_decimal_reads_and_writes_back_unchanged(
        whole in 0_u64..1_000_000_000_000,
        fraction in 0_u64..1_000_000_000,
        digits in 1_u32..10,
        negative in any::<bool>(),
    ) {
        // `digits` fractional digits, zero padded; the value is exact, so rounding to `digits`
        // writes the same text.
        let fraction = fraction % 10_u64.pow(digits);
        let sign = if negative && (whole != 0 || fraction != 0) { "-" } else { "" };
        let text = format!("{sign}{whole}.{fraction:0>width$}", width = digits as usize);
        prop_assert_eq!(Q::parse(&text).unwrap().to_fixed(digits).unwrap(), text);
    }

    #[test]
    fn a_sum_taken_at_once_equals_the_sum_taken_step_by_step(
        terms in proptest::collection::vec((-10_000_i128..10_000, 1_i128..10_000), 0..40),
    ) {
        let values: Vec<Q> = terms.iter().map(|(n, d)| q(*n, *d)).collect();
        let mut stepwise = Q::zero();
        for value in &values {
            stepwise = &stepwise + value;
        }
        prop_assert_eq!(Q::sum(values.iter()), stepwise);
    }
}

#[test]
fn every_tie_rounds_to_the_even_neighbour() {
    // k + 1/2 at scale 0, and k + 5/10^s at scale s: the result is always even in the last digit.
    for scale in 0_u32..6 {
        let unit = 10_i128.pow(scale);
        for k in -20_i128..20 {
            let tie = q(2 * (k * unit) + 1, 2 * unit);
            let text = tie.to_fixed(scale).unwrap();
            let digit = text.bytes().rev().find(u8::is_ascii_digit).unwrap() - b'0';
            assert_eq!(digit % 2, 0, "{tie} at scale {scale} gave {text}");
        }
    }
}

#[test]
fn values_beyond_128_bits_stay_exact() {
    // (10^40 + 1) / 10^40 has a numerator no 128-bit integer holds. The rounded text still
    // carries the digit that the fraction adds at the 40th place.
    let big = BigInt::from(10).pow(40);
    let value = Q::new(&big + 1, big.clone()).unwrap();
    assert_eq!(value.to_fixed(2).unwrap(), "1.00");
    let tiny = &value - &Q::one();
    assert_eq!(tiny.to_fixed(40).unwrap(), format!("0.{:0>40}", 1));
    assert_eq!((&tiny * &Q::new(big, BigInt::from(1)).unwrap()), Q::one());
}
