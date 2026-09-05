use city_core::generator::{GeneratorConfig, generate_demo_scene};
use city_core::jurisdiction::JurisdictionId;
use city_core::validate;
use std::{env, fs, str::FromStr};
mod window;

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = env::args().collect();
    if args.iter().any(|arg| arg == "--window") {
        return window::run();
    }
    let output = args
        .windows(2)
        .find(|pair| pair[0] == "--out")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| "city.scene.json".into());
    let jurisdiction = args
        .windows(2)
        .find(|pair| pair[0] == "--jurisdiction")
        .map(|pair| pair[1].to_ascii_lowercase())
        .and_then(|name| JurisdictionId::from_str(&name).ok())
        .unwrap_or(JurisdictionId::ChinaMainland);
    let scene = generate_demo_scene(&GeneratorConfig {
        jurisdiction,
        ..Default::default()
    });
    validate(&scene.city).map_err(anyhow::Error::msg)?;
    let json = serde_json::to_string_pretty(&scene)?;
    fs::write(&output, json)?;
    println!(
        "generated {} roads and {} junction(s) -> {}",
        scene.city.roads.len(),
        scene.city.junctions.len(),
        output
    );
    Ok(())
}
