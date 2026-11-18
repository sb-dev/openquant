//! `engine-batch`: the batch host of the connected competition (OQ-05 sections 4 and 5).
//!
//! It reads its configuration from the environment, pulls job messages from one Cloudflare queue
//! over HTTP, claims each attempt through the application API, runs the `retrieve`, `validate`,
//! `evaluate` or `assess` job and acknowledges the message after the result is committed. Every
//! request goes through the egress module. The binary exits 0 after a stop request, 1 when the
//! worker cannot go on (a credential is refused) and 2 for a usage or configuration error. An
//! error names the variable, never a value.

use std::{process::ExitCode, sync::Arc, thread};

use openquant_engine::batch::{
    clock::{RealTime, Time},
    config::{Config, ENV_TEST_LOOPBACK_ROOT},
    egress::Policy,
    identity::ExecutableId,
    wire::UreqWire,
    worker::{Log, Worker},
};

const USAGE: &str = "usage: engine-batch [--check-config]

Run the batch worker. The configuration comes from the environment:
  OPENQUANT_ENVIRONMENT, OPENQUANT_API_URL, OPENQUANT_API_TOKEN,
  OPENQUANT_QUEUE_ACCOUNT_ID, OPENQUANT_QUEUE_ID, OPENQUANT_QUEUE_TOKEN
and, optionally, OPENQUANT_MARKET_RETRIEVAL (exactly `enabled` turns provider retrieval on),
OPENQUANT_ALPACA_KEY_ID, OPENQUANT_ALPACA_SECRET, OPENQUANT_PROVIDER_EVIDENCE_FILE,
OPENQUANT_CONCURRENCY (1 or 2), OPENQUANT_VISIBILITY_SECONDS and OPENQUANT_STOP_FILE.
On a Fly Machine, FLY_MACHINE_ID (set by Fly) goes into the worker name of each claim.

  --check-config   read the configuration, print `configuration ok` and exit
  --help           print this text
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let check_only = match args.as_slice() {
        [] => false,
        [flag] if flag == "--check-config" => true,
        [flag] if flag == "--help" || flag == "-h" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => {
            eprint!("engine-batch: unknown arguments\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("engine-batch: {error}");
            return ExitCode::from(2);
        }
    };
    if check_only {
        println!("configuration ok");
        return ExitCode::SUCCESS;
    }
    let executable = match ExecutableId::measure() {
        Ok(executable) => executable,
        Err(error) => {
            eprintln!("engine-batch: cannot measure the executable: {error}");
            return ExitCode::from(1);
        }
    };
    let time: Arc<dyn Time> = Arc::new(RealTime::new());
    let log: Log = {
        let time = Arc::clone(&time);
        Arc::new(move |line: &str| eprintln!("{} {line}", time.now()))
    };
    let wire = match &config.loopback {
        None => Arc::new(UreqWire::new()),
        // Test only (a debug build in DEVELOPMENT, see `config::LoopbackTest`): the hosts of the
        // allowlist resolve to the loopback port. The allowlist itself does not change.
        Some(loopback) => {
            let root = match std::fs::read(&loopback.root_der) {
                Ok(root) => root,
                Err(_) => {
                    eprintln!(
                        "engine-batch: the variable {ENV_TEST_LOOPBACK_ROOT} names a file that cannot be read"
                    );
                    return ExitCode::from(2);
                }
            };
            let policy =
                match Policy::batch(&config.api, &config.queue_account_id, &config.queue_id) {
                    Ok(policy) => policy,
                    Err(error) => {
                        eprintln!("engine-batch: {error}");
                        return ExitCode::from(2);
                    }
                };
            let mut hosts: Vec<String> = policy
                .rules()
                .iter()
                .map(|rule| rule.host.clone())
                .collect();
            hosts.sort();
            hosts.dedup();
            log(&format!(
                "TEST LOOPBACK MODE: {} allowlisted hosts resolve to 127.0.0.1:{}",
                hosts.len(),
                loopback.port
            ));
            Arc::new(UreqWire::for_loopback(root, &hosts, loopback.port))
        }
    };
    let concurrency = config.concurrency;
    log(&format!(
        "engine-batch {} starting in {} with {concurrency} worker(s)",
        executable.version, config.environment
    ));
    let mut workers = Vec::new();
    for index in 0..concurrency {
        // On a Fly Machine the name carries FLY_MACHINE_ID, for the API's termination probe.
        let worker_id = config.worker_id(std::process::id(), index);
        match Worker::new(
            config.clone(),
            wire.clone(),
            Arc::clone(&time),
            executable.clone(),
            &worker_id,
            Arc::clone(&log),
        ) {
            Ok(worker) => workers.push(worker),
            Err(error) => {
                eprintln!("engine-batch: {error}");
                return ExitCode::from(2);
            }
        }
    }
    let failures: Vec<String> = thread::scope(|scope| {
        let handles: Vec<_> = workers
            .iter()
            .map(|worker| scope.spawn(move || worker.run()))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| match handle.join() {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.to_string()),
                Err(_) => Some("a worker thread stopped unexpectedly".to_owned()),
            })
            .collect()
    });
    if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        for failure in failures {
            eprintln!("engine-batch: {failure}");
        }
        ExitCode::from(1)
    }
}
