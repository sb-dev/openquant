//! Time for the batch host: the wall clock, a monotonic clock and sleeping, behind one trait so a
//! test moves time by hand.

use std::{
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::market::{
    provider::{Clock, Sleeper},
    time::Timestamp,
};

/// Wall-clock and monotonic time, and sleeping.
pub trait Time: Send + Sync {
    /// The current UTC time.
    fn now(&self) -> Timestamp;

    /// Milliseconds since an arbitrary start. Never goes back.
    fn monotonic_ms(&self) -> u64;

    /// Block for `milliseconds`.
    fn sleep_ms(&self, milliseconds: u64);
}

/// The real clocks.
#[derive(Debug)]
pub struct RealTime {
    start: Instant,
}

impl RealTime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Default for RealTime {
    fn default() -> Self {
        Self::new()
    }
}

impl Time for RealTime {
    fn now(&self) -> Timestamp {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(0));
        Timestamp::from_epoch_seconds(seconds)
    }

    fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sleep_ms(&self, milliseconds: u64) {
        thread::sleep(Duration::from_millis(milliseconds));
    }
}

/// A [`Time`] seen as the market module's [`Clock`].
pub struct TimeClock<'a>(pub &'a dyn Time);

impl Clock for TimeClock<'_> {
    fn now(&self) -> Timestamp {
        self.0.now()
    }
}

/// A [`Time`] seen as the market module's [`Sleeper`].
pub struct TimeSleeper<'a>(pub &'a dyn Time);

impl Sleeper for TimeSleeper<'_> {
    fn sleep(&self, seconds: u64) {
        self.0.sleep_ms(seconds.saturating_mul(1000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_clocks_move_forward() {
        let time = RealTime::new();
        let before = time.monotonic_ms();
        time.sleep_ms(5);
        assert!(time.monotonic_ms() >= before + 5);
        // After 2020-01-01 and before 2200-01-01: the wall clock is a real clock.
        let now = time.now().epoch_seconds();
        assert!(now > 1_577_836_800 && now < 7_258_118_400, "{now}");
    }
}
