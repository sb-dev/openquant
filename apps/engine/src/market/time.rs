//! Calendar dates, UTC instants and the US Eastern rule, in integer arithmetic only.
//!
//! The market calendar and the daily-bar timestamps of a provider are local times of
//! `America/New_York`. The offset follows the US rule in force since 2007: daylight time starts at
//! 02:00 local standard time on the second Sunday of March and ends at 02:00 local daylight time
//! on the first Sunday of November. Years outside 2007 to 2099 are refused, so a change of the
//! rule needs a change of this code rather than a silently wrong offset. A local time that does
//! not exist (the spring gap) or occurs twice (the autumn overlap) is an error, never a guess.

use std::fmt;

/// Seconds in one day.
const DAY: i64 = 86_400;

/// First and last year for which the Eastern rule below holds.
const FIRST_YEAR: i64 = 2007;
const LAST_YEAR: i64 = 2099;

/// A calendar date, counted in days since 1970-01-01.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date(i64);

/// A UTC instant at second precision, counted in seconds since 1970-01-01T00:00:00Z.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

/// Why a date, an instant or a local time was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeError {
    /// The text is not `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SSZ` or `HH:MM`.
    Malformed,
    /// The date does not exist in the calendar.
    NoSuchDate,
    /// The year is outside 2007 to 2099, where the Eastern rule below holds.
    UnsupportedYear,
    /// The local time falls in the hour that the spring transition skips.
    NonExistentLocalTime,
    /// The local time occurs twice, in the hour that the autumn transition repeats.
    AmbiguousLocalTime,
}

impl fmt::Display for TimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "malformed date or time text",
            Self::NoSuchDate => "no such calendar date",
            Self::UnsupportedYear => "year outside 2007 to 2099",
            Self::NonExistentLocalTime => "local time skipped by the spring transition",
            Self::AmbiguousLocalTime => "local time repeated by the autumn transition",
        })
    }
}

impl std::error::Error for TimeError {}

/// Civil date to days since 1970-01-01 (proleptic Gregorian calendar).
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Days since 1970-01-01 to the civil date `(year, month, day)`.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

const fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Parse a fixed-width run of ASCII digits.
fn digits(text: &str, start: usize, end: usize) -> Result<i64, TimeError> {
    let part = text.get(start..end).ok_or(TimeError::Malformed)?;
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(TimeError::Malformed);
    }
    part.parse().map_err(|_| TimeError::Malformed)
}

/// Whether the byte at `index` is `expected`.
fn byte_is(text: &str, index: usize, expected: u8) -> bool {
    text.as_bytes().get(index).copied() == Some(expected)
}

impl Date {
    /// Build a date from its parts.
    ///
    /// # Errors
    /// [`TimeError::UnsupportedYear`] outside 2007 to 2099, [`TimeError::NoSuchDate`] for a month
    /// or day that does not exist.
    pub fn new(year: i64, month: i64, day: i64) -> Result<Self, TimeError> {
        if !(FIRST_YEAR..=LAST_YEAR).contains(&year) {
            return Err(TimeError::UnsupportedYear);
        }
        if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
            return Err(TimeError::NoSuchDate);
        }
        Ok(Self(days_from_civil(year, month, day)))
    }

    /// Parse `YYYY-MM-DD`, exactly.
    ///
    /// # Errors
    /// [`TimeError::Malformed`] for any other shape, plus the errors of [`Date::new`].
    pub fn parse(text: &str) -> Result<Self, TimeError> {
        if text.len() != 10 || !byte_is(text, 4, b'-') || !byte_is(text, 7, b'-') {
            return Err(TimeError::Malformed);
        }
        Self::new(
            digits(text, 0, 4)?,
            digits(text, 5, 7)?,
            digits(text, 8, 10)?,
        )
    }

    /// The `(year, month, day)` of this date.
    #[must_use]
    pub const fn parts(self) -> (i64, i64, i64) {
        civil_from_days(self.0)
    }

    /// The date `days` later (earlier when negative).
    #[must_use]
    pub const fn add_days(self, days: i64) -> Self {
        Self(self.0 + days)
    }

    /// Days from `earlier` to this date.
    #[must_use]
    pub const fn days_since(self, earlier: Self) -> i64 {
        self.0 - earlier.0
    }

    /// Day of the week, Monday 0 to Sunday 6. 1970-01-01 was a Thursday.
    #[must_use]
    pub const fn weekday(self) -> i64 {
        (self.0 + 3).rem_euclid(7)
    }

    /// Whether this date is a Saturday or a Sunday.
    #[must_use]
    pub const fn is_weekend(self) -> bool {
        self.weekday() >= 5
    }

    /// The instant 00:00:00 UTC of this date.
    #[must_use]
    pub const fn start_of_day_utc(self) -> Timestamp {
        Timestamp(self.0 * DAY)
    }

    /// The `n`th Sunday (1 for the first) of `month` in `year`.
    fn nth_sunday(year: i64, month: i64, n: i64) -> Result<Self, TimeError> {
        let first = Self::new(year, month, 1)?;
        let to_sunday = (6 - first.weekday()).rem_euclid(7);
        Ok(first.add_days(to_sunday + 7 * (n - 1)))
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (year, month, day) = self.parts();
        write!(f, "{year:04}-{month:02}-{day:02}")
    }
}

impl Timestamp {
    /// An instant from seconds since the epoch.
    #[must_use]
    pub const fn from_epoch_seconds(seconds: i64) -> Self {
        Self(seconds)
    }

    /// Seconds since 1970-01-01T00:00:00Z.
    #[must_use]
    pub const fn epoch_seconds(self) -> i64 {
        self.0
    }

    /// Parse `YYYY-MM-DDTHH:MM:SSZ`, exactly: no fraction, no offset, no lower-case letters.
    ///
    /// # Errors
    /// [`TimeError::Malformed`] for any other shape, [`TimeError::NoSuchDate`] for a time of day
    /// that does not exist, plus the errors of [`Date::parse`].
    pub fn parse(text: &str) -> Result<Self, TimeError> {
        if text.len() != 20
            || !byte_is(text, 10, b'T')
            || !byte_is(text, 13, b':')
            || !byte_is(text, 16, b':')
            || !byte_is(text, 19, b'Z')
        {
            return Err(TimeError::Malformed);
        }
        let date = Date::parse(text.get(..10).ok_or(TimeError::Malformed)?)?;
        let (hour, minute, second) = (
            digits(text, 11, 13)?,
            digits(text, 14, 16)?,
            digits(text, 17, 19)?,
        );
        if hour > 23 || minute > 59 || second > 59 {
            return Err(TimeError::NoSuchDate);
        }
        Ok(Self(
            date.start_of_day_utc().0 + hour * 3600 + minute * 60 + second,
        ))
    }

    /// The instant `seconds` later (earlier when negative).
    #[must_use]
    pub const fn add_seconds(self, seconds: i64) -> Self {
        Self(self.0 + seconds)
    }

    /// Whole seconds from `earlier` to this instant.
    #[must_use]
    pub const fn seconds_since(self, earlier: Self) -> i64 {
        self.0 - earlier.0
    }

    /// The UTC calendar date that contains this instant.
    #[must_use]
    pub const fn date_utc(self) -> Date {
        Date(self.0.div_euclid(DAY))
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let date = self.date_utc();
        let seconds = self.0.rem_euclid(DAY);
        write!(
            f,
            "{date}T{:02}:{:02}:{:02}Z",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        )
    }
}

/// A local time of day, `HH:MM`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalTime {
    hour: u8,
    minute: u8,
}

impl LocalTime {
    /// Parse `HH:MM`, exactly.
    ///
    /// # Errors
    /// [`TimeError::Malformed`] for any other shape, [`TimeError::NoSuchDate`] for an hour above
    /// 23 or a minute above 59.
    pub fn parse(text: &str) -> Result<Self, TimeError> {
        if text.len() != 5 || !byte_is(text, 2, b':') {
            return Err(TimeError::Malformed);
        }
        let (hour, minute) = (digits(text, 0, 2)?, digits(text, 3, 5)?);
        if hour > 23 || minute > 59 {
            return Err(TimeError::NoSuchDate);
        }
        Ok(Self {
            hour: u8::try_from(hour).map_err(|_| TimeError::Malformed)?,
            minute: u8::try_from(minute).map_err(|_| TimeError::Malformed)?,
        })
    }

    /// Hour of the day, 0 to 23.
    #[must_use]
    pub const fn hour(self) -> u8 {
        self.hour
    }

    /// Minute of the hour, 0 to 59.
    #[must_use]
    pub const fn minute(self) -> u8 {
        self.minute
    }
}

/// Offset of US Eastern time from UTC, in seconds: -5 hours standard, -4 hours daylight.
fn eastern_offset(date: Date, hour: u8) -> Result<i64, TimeError> {
    const STANDARD: i64 = -5 * 3600;
    const DAYLIGHT: i64 = -4 * 3600;
    let (year, _, _) = date.parts();
    let start = Date::nth_sunday(year, 3, 2)?;
    let end = Date::nth_sunday(year, 11, 1)?;
    if date < start || date > end {
        return Ok(STANDARD);
    }
    if date == start {
        // 02:00 standard time becomes 03:00 daylight time.
        return match hour {
            0 | 1 => Ok(STANDARD),
            2 => Err(TimeError::NonExistentLocalTime),
            _ => Ok(DAYLIGHT),
        };
    }
    if date == end {
        // 02:00 daylight time becomes 01:00 standard time.
        return match hour {
            0 => Ok(DAYLIGHT),
            1 => Err(TimeError::AmbiguousLocalTime),
            _ => Ok(STANDARD),
        };
    }
    Ok(DAYLIGHT)
}

/// The UTC instant of a local `America/New_York` date and time of day.
///
/// # Errors
/// [`TimeError::UnsupportedYear`] outside 2007 to 2099, [`TimeError::NonExistentLocalTime`] in the
/// skipped hour of the spring transition and [`TimeError::AmbiguousLocalTime`] in the repeated
/// hour of the autumn transition.
pub fn eastern_to_utc(date: Date, time: LocalTime) -> Result<Timestamp, TimeError> {
    let offset = eastern_offset(date, time.hour)?;
    let local =
        date.start_of_day_utc().0 + i64::from(time.hour) * 3600 + i64::from(time.minute) * 60;
    Ok(Timestamp(local - offset))
}

/// The session date of a daily bar whose timestamp must be local midnight Eastern.
///
/// A provider stamps a daily bar with the start of the trading day in New York: 05:00Z in winter
/// and 04:00Z in summer. Any other time of day is not a daily-bar start.
///
/// # Errors
/// [`TimeError::Malformed`] when the instant is not local midnight, plus the errors of
/// [`eastern_to_utc`].
pub fn session_from_midnight(stamp: Timestamp) -> Result<Date, TimeError> {
    let date = stamp.date_utc();
    let midnight = LocalTime { hour: 0, minute: 0 };
    if eastern_to_utc(date, midnight)? == stamp {
        Ok(date)
    } else {
        Err(TimeError::Malformed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip_over_the_supported_years() {
        let mut date = Date::new(2007, 1, 1).unwrap();
        let last = Date::new(2099, 12, 31).unwrap();
        let mut count = 0;
        while date <= last {
            let (y, m, d) = date.parts();
            assert_eq!(Date::new(y, m, d).unwrap(), date);
            assert_eq!(Date::parse(&date.to_string()).unwrap(), date);
            date = date.add_days(1);
            count += 1;
        }
        // 93 years: 23 leap years (2008 to 2096) of 366 days and 70 of 365.
        assert_eq!(count, 23 * 366 + 70 * 365);
    }

    #[test]
    fn weekdays_match_known_dates() {
        // Monday 0 ... Sunday 6; each date checked against a printed calendar.
        assert_eq!(Date::parse("2024-03-11").unwrap().weekday(), 0);
        assert_eq!(Date::parse("2024-03-10").unwrap().weekday(), 6);
        assert_eq!(Date::parse("2025-02-11").unwrap().weekday(), 1);
        assert_eq!(Date::parse("2023-11-23").unwrap().weekday(), 3);
        assert!(Date::parse("2024-03-09").unwrap().is_weekend());
        assert!(!Date::parse("2024-03-08").unwrap().is_weekend());
    }

    #[test]
    fn rejects_malformed_and_unsupported_dates() {
        assert_eq!(Date::parse("2024-3-11"), Err(TimeError::Malformed));
        assert_eq!(Date::parse("2024-03-11 "), Err(TimeError::Malformed));
        assert_eq!(Date::parse("2024/03/11"), Err(TimeError::Malformed));
        assert_eq!(Date::parse("2024-02-30"), Err(TimeError::NoSuchDate));
        assert_eq!(Date::parse("2023-02-29"), Err(TimeError::NoSuchDate));
        assert_eq!(Date::parse("2006-12-31"), Err(TimeError::UnsupportedYear));
        assert_eq!(Date::parse("2100-01-01"), Err(TimeError::UnsupportedYear));
        assert_eq!(Date::parse("2024-13-01"), Err(TimeError::NoSuchDate));
    }

    #[test]
    fn timestamps_parse_and_format_exactly() {
        let t = Timestamp::parse("2024-03-08T21:00:00Z").unwrap();
        assert_eq!(t.to_string(), "2024-03-08T21:00:00Z");
        assert_eq!(t.epoch_seconds(), 1_709_931_600);
        assert_eq!(t.add_seconds(7200).to_string(), "2024-03-08T23:00:00Z");
        assert_eq!(t.add_seconds(3 * 3600).to_string(), "2024-03-09T00:00:00Z");
        for bad in [
            "2024-03-08T21:00:00",
            "2024-03-08 21:00:00Z",
            "2024-03-08T21:00:00.5Z",
            "2024-03-08T21:00:00+00:00",
            "2024-03-08T24:00:00Z",
            "2024-03-08t21:00:00Z",
        ] {
            assert!(Timestamp::parse(bad).is_err(), "{bad}");
        }
    }

    /// Transition dates computed independently with Python's `zoneinfo` (tzdata), 2007 to 2035.
    #[test]
    fn transition_dates_match_the_tz_database() {
        let spring = [
            (2007, 3, 11),
            (2008, 3, 9),
            (2009, 3, 8),
            (2010, 3, 14),
            (2011, 3, 13),
            (2012, 3, 11),
            (2013, 3, 10),
            (2014, 3, 9),
            (2015, 3, 8),
            (2016, 3, 13),
            (2017, 3, 12),
            (2018, 3, 11),
            (2019, 3, 10),
            (2020, 3, 8),
            (2021, 3, 14),
            (2022, 3, 13),
            (2023, 3, 12),
            (2024, 3, 10),
            (2025, 3, 9),
            (2026, 3, 8),
            (2027, 3, 14),
            (2028, 3, 12),
            (2029, 3, 11),
            (2030, 3, 10),
            (2031, 3, 9),
            (2032, 3, 14),
            (2033, 3, 13),
            (2034, 3, 12),
            (2035, 3, 11),
        ];
        let autumn = [
            (2007, 11, 4),
            (2008, 11, 2),
            (2009, 11, 1),
            (2010, 11, 7),
            (2011, 11, 6),
            (2012, 11, 4),
            (2013, 11, 3),
            (2014, 11, 2),
            (2015, 11, 1),
            (2016, 11, 6),
            (2017, 11, 5),
            (2018, 11, 4),
            (2019, 11, 3),
            (2020, 11, 1),
            (2021, 11, 7),
            (2022, 11, 6),
            (2023, 11, 5),
            (2024, 11, 3),
            (2025, 11, 2),
            (2026, 11, 1),
            (2027, 11, 7),
            (2028, 11, 5),
            (2029, 11, 4),
            (2030, 11, 3),
            (2031, 11, 2),
            (2032, 11, 7),
            (2033, 11, 6),
            (2034, 11, 5),
            (2035, 11, 4),
        ];
        for (year, month, day) in spring {
            assert_eq!(
                Date::nth_sunday(year, 3, 2).unwrap(),
                Date::new(year, month, day).unwrap()
            );
        }
        for (year, month, day) in autumn {
            assert_eq!(
                Date::nth_sunday(year, 11, 1).unwrap(),
                Date::new(year, month, day).unwrap()
            );
        }
    }

    #[test]
    fn local_times_convert_on_both_sides_of_each_transition() {
        let nine_thirty = LocalTime::parse("09:30").unwrap();
        let four = LocalTime::parse("16:00").unwrap();
        let utc = |date: &str, time: LocalTime| {
            eastern_to_utc(Date::parse(date).unwrap(), time)
                .unwrap()
                .to_string()
        };
        // Spring 2024: Friday 8 March is standard time, Monday 11 March daylight time.
        assert_eq!(utc("2024-03-08", nine_thirty), "2024-03-08T14:30:00Z");
        assert_eq!(utc("2024-03-08", four), "2024-03-08T21:00:00Z");
        assert_eq!(utc("2024-03-11", nine_thirty), "2024-03-11T13:30:00Z");
        assert_eq!(utc("2024-03-11", four), "2024-03-11T20:00:00Z");
        // Autumn 2024: Friday 1 November is daylight time, Monday 4 November standard time.
        assert_eq!(utc("2024-11-01", four), "2024-11-01T20:00:00Z");
        assert_eq!(utc("2024-11-04", four), "2024-11-04T21:00:00Z");
        // On the transition days themselves, away from the changing hour.
        assert_eq!(
            utc("2024-03-10", LocalTime::parse("01:59").unwrap()),
            "2024-03-10T06:59:00Z"
        );
        assert_eq!(
            utc("2024-03-10", LocalTime::parse("03:00").unwrap()),
            "2024-03-10T07:00:00Z"
        );
        assert_eq!(
            utc("2024-11-03", LocalTime::parse("00:30").unwrap()),
            "2024-11-03T04:30:00Z"
        );
        assert_eq!(
            utc("2024-11-03", LocalTime::parse("02:00").unwrap()),
            "2024-11-03T07:00:00Z"
        );
    }

    #[test]
    fn the_skipped_and_the_repeated_hour_are_refused() {
        let spring = Date::parse("2024-03-10").unwrap();
        let autumn = Date::parse("2024-11-03").unwrap();
        for time in ["02:00", "02:30", "02:59"] {
            assert_eq!(
                eastern_to_utc(spring, LocalTime::parse(time).unwrap()),
                Err(TimeError::NonExistentLocalTime),
                "{time}"
            );
        }
        for time in ["01:00", "01:30", "01:59"] {
            assert_eq!(
                eastern_to_utc(autumn, LocalTime::parse(time).unwrap()),
                Err(TimeError::AmbiguousLocalTime),
                "{time}"
            );
        }
        let early = Date::new(2006, 12, 29);
        assert_eq!(early, Err(TimeError::UnsupportedYear));
    }

    #[test]
    fn a_daily_bar_stamp_is_local_midnight_in_summer_and_in_winter() {
        let winter = Timestamp::parse("2024-01-02T05:00:00Z").unwrap();
        let summer = Timestamp::parse("2024-07-01T04:00:00Z").unwrap();
        assert_eq!(
            session_from_midnight(winter).unwrap().to_string(),
            "2024-01-02"
        );
        assert_eq!(
            session_from_midnight(summer).unwrap().to_string(),
            "2024-07-01"
        );
        // The winter stamp in summer, the summer stamp in winter and a midnight UTC stamp.
        for bad in [
            "2024-07-01T05:00:00Z",
            "2024-01-02T04:00:00Z",
            "2024-01-02T00:00:00Z",
        ] {
            assert_eq!(
                session_from_midnight(Timestamp::parse(bad).unwrap()),
                Err(TimeError::Malformed),
                "{bad}"
            );
        }
        // Midnight on the transition days exists and is standard time on the way in.
        let spring_day = Timestamp::parse("2024-03-10T05:00:00Z").unwrap();
        let autumn_day = Timestamp::parse("2024-11-03T04:00:00Z").unwrap();
        assert_eq!(
            session_from_midnight(spring_day).unwrap().to_string(),
            "2024-03-10"
        );
        assert_eq!(
            session_from_midnight(autumn_day).unwrap().to_string(),
            "2024-11-03"
        );
    }

    #[test]
    fn local_time_text_is_strict() {
        assert!(LocalTime::parse("09:30").is_ok());
        for bad in ["9:30", "0930", "09:3", "24:00", "09:60", "09-30", " 09:30"] {
            assert!(LocalTime::parse(bad).is_err(), "{bad}");
        }
    }
}
