//! Region-aware asset descriptors. Geometry backends can turn these into
//! high-detail meshes or stream photogrammetry assets without changing city data.
use rand::{Rng, SeedableRng, rngs::StdRng};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum BuildingStyle {
    ChineseHighRise,
    ChineseMidRise,
    EuropeanPerimeter,
    NorthAmericanDetached,
    JapaneseCompact,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum TreeSpecies {
    ChinesePlane,
    Ginkgo,
    LondonPlane,
    Maple,
    Cedar,
    Bamboo,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildingProfile {
    pub style: BuildingStyle,
    pub floors: u16,
    pub footprint_m: (f64, f64),
    pub setback_m: f64,
    pub balcony_probability: f32,
    pub facade_variation: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeProfile {
    pub species: TreeSpecies,
    pub height_m: f32,
    pub crown_radius_m: f32,
    pub trunk_radius_m: f32,
    pub leaf_density: f32,
}

pub fn sample_building(style: BuildingStyle, seed: u64, density: f32) -> BuildingProfile {
    let mut rng = StdRng::seed_from_u64(seed);
    let floors = match style {
        BuildingStyle::ChineseHighRise => rng.random_range(24..=58),
        BuildingStyle::ChineseMidRise => rng.random_range(8..=twenty(24)),
        BuildingStyle::EuropeanPerimeter => rng.random_range(4..=9),
        BuildingStyle::NorthAmericanDetached => rng.random_range(1..=3),
        BuildingStyle::JapaneseCompact => rng.random_range(3..=14),
    };
    let footprint = match style {
        BuildingStyle::NorthAmericanDetached => (
            8.0 + rng.random::<f64>() * 8.0,
            10.0 + rng.random::<f64>() * 12.0,
        ),
        BuildingStyle::ChineseHighRise => (
            18.0 + rng.random::<f64>() * 18.0,
            22.0 + rng.random::<f64>() * 26.0,
        ),
        BuildingStyle::EuropeanPerimeter => (
            10.0 + rng.random::<f64>() * 15.0,
            24.0 + rng.random::<f64>() * 30.0,
        ),
        _ => (
            10.0 + rng.random::<f64>() * 14.0,
            14.0 + rng.random::<f64>() * 20.0,
        ),
    };
    BuildingProfile {
        style,
        floors,
        footprint_m: footprint,
        setback_m: 2.0 + (1.0 - density) as f64 * 5.0,
        balcony_probability: if matches!(
            style,
            BuildingStyle::ChineseHighRise | BuildingStyle::ChineseMidRise
        ) {
            0.72
        } else {
            0.28
        },
        facade_variation: 0.35 + rng.random::<f32>() * 0.5,
    }
}

pub fn sample_tree(species: TreeSpecies, seed: u64) -> TreeProfile {
    let mut rng = StdRng::seed_from_u64(seed);
    let (height, crown, trunk, density) = match species {
        TreeSpecies::ChinesePlane => (18.0, 6.0, 0.38, 0.82),
        TreeSpecies::Ginkgo => (15.0, 4.8, 0.30, 0.70),
        TreeSpecies::LondonPlane => (20.0, 6.5, 0.42, 0.84),
        TreeSpecies::Maple => (13.0, 5.0, 0.28, 0.76),
        TreeSpecies::Cedar => (22.0, 4.2, 0.35, 0.88),
        TreeSpecies::Bamboo => (8.0, 1.5, 0.08, 0.92),
    };
    let variation = 0.82 + rng.random::<f32>() * 0.36;
    TreeProfile {
        species,
        height_m: height * variation,
        crown_radius_m: crown * variation,
        trunk_radius_m: trunk * variation,
        leaf_density: density * (0.9 + rng.random::<f32>() * 0.2),
    }
}

const fn twenty(v: u16) -> u16 {
    v
}
