//! Native harness: same code path as the wasm module, so the extraction can be
//! diffed against the Python reference without a wasm runtime in the loop.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: {} <rom.sfc> <out.dat> [--no-hash-check] [--no-include-rom]", args[0]);
        std::process::exit(2);
    }
    let mut flags = 0;
    for a in &args[3..] {
        match a.as_str() {
            "--no-hash-check" => flags |= smw_restool::FLAG_NO_HASH_CHECK,
            "--no-include-rom" => flags |= smw_restool::FLAG_NO_INCLUDE_ROM,
            other => {
                eprintln!("unknown flag {other}");
                std::process::exit(2);
            }
        }
    }
    let input = std::fs::read(&args[1]).expect("read rom");
    match smw_restool::run_extraction(input, flags) {
        Ok(e) => {
            for w in &e.warnings {
                eprintln!("{w}");
            }
            std::fs::write(&args[2], &e.data).expect("write output");
            eprintln!("wrote {} ({} bytes)", args[2], e.data.len());
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
