//! Deterministic city and junction fixtures used by the native editor,
//! simulation tests, and offline render jobs.
use crate::jurisdiction::{JurisdictionId, TrafficRules};
use crate::traffic::{ApproachSpec, synthesize_junction};
use crate::{CityDocument, CityNode, Junction, Road, RoadClass};
use crate::{
    assets::{BuildingStyle, TreeSpecies},
    scene::{NativeScene, populate_assets},
};
use glam::DVec2;

#[derive(Clone, Debug)]
pub struct GeneratorConfig {
    pub seed: u64,
    pub jurisdiction: JurisdictionId,
    pub approach_lanes: u8,
    pub protected_left: bool,
    pub right_turn_lanes: bool,
}

impl Default for GeneratorConfig {
    fn default() -> Self {
        Self {
            seed: 42,
            jurisdiction: JurisdictionId::ChinaMainland,
            approach_lanes: 4,
            protected_left: true,
            right_turn_lanes: true,
        }
    }
}

/// Creates a four-arm, multi-lane signalized intersection. The result is
/// topology-first: renderers place asphalt, arrows and signal poles from it.
pub fn generate_demo_city(config: &GeneratorConfig) -> CityDocument {
    let rules = TrafficRules::for_jurisdiction(config.jurisdiction);
    let names = ["north", "east", "south", "west"];
    let approaches: Vec<_> = names
        .iter()
        .map(|id| ApproachSpec {
            id: (*id).into(),
            lanes_in: config.approach_lanes.max(2),
            lanes_out: config.approach_lanes.max(2),
            protected_left: config.protected_left,
            right_turn_lane: config.right_turn_lanes,
            pedestrian: true,
        })
        .collect();
    let plan = synthesize_junction(&rules, &approaches);
    let mut roads = Vec::new();
    let nodes = vec![
        CityNode {
            id: "node/north".into(),
            position_m: DVec2::new(0.0, -360.0),
            role: "boundary".into(),
        },
        CityNode {
            id: "node/east".into(),
            position_m: DVec2::new(360.0, 0.0),
            role: "boundary".into(),
        },
        CityNode {
            id: "node/south".into(),
            position_m: DVec2::new(0.0, 360.0),
            role: "boundary".into(),
        },
        CityNode {
            id: "node/west".into(),
            position_m: DVec2::new(-360.0, 0.0),
            role: "boundary".into(),
        },
    ];
    for (i, name) in names.iter().enumerate() {
        let (a, b) = if i % 2 == 0 {
            (DVec2::new(0.0, -360.0), DVec2::new(0.0, 360.0))
        } else {
            (DVec2::new(-360.0, 0.0), DVec2::new(360.0, 0.0))
        };
        let lanes = plan
            .lanes
            .iter()
            .filter(|lane| lane.approach == *name)
            .cloned()
            .collect();
        roads.push(Road {
            id: format!("road/{}", name),
            from_node: format!("node/{}", name),
            to_node: format!(
                "node/{}",
                if i % 2 == 0 {
                    if i == 0 { "south" } else { "north" }
                } else {
                    if i == 1 { "west" } else { "east" }
                }
            ),
            class: RoadClass::Arterial,
            centerline: vec![a, b],
            lanes,
            layer: 0,
        });
    }
    let junction = Junction {
        id: "junction/central".into(),
        roads: roads.iter().map(|r| r.id.clone()).collect(),
        phases: plan.phases,
        markings: plan.markings,
        kind: plan.kind,
        signal_heads: plan.signal_heads,
        conflict_pairs: plan.conflict_pairs,
    };
    CityDocument {
        version: 1,
        jurisdiction: format!("{:?}", config.jurisdiction),
        seed: config.seed,
        nodes,
        roads,
        junctions: vec![junction],
    }
}

pub fn generate_demo_scene(config: &GeneratorConfig) -> NativeScene {
    let city = crate::urban::generate_urban_city(&crate::urban::UrbanConfig {
        seed: config.seed,
        jurisdiction: config.jurisdiction,
        ..Default::default()
    });
    let (primary_style, landmark_style, street_tree, understory) = match config.jurisdiction {
        JurisdictionId::ChinaMainland => (
            BuildingStyle::ChineseMidRise,
            BuildingStyle::ChineseHighRise,
            TreeSpecies::ChinesePlane,
            TreeSpecies::Ginkgo,
        ),
        JurisdictionId::UnitedStates => (
            BuildingStyle::NorthAmericanDetached,
            BuildingStyle::NorthAmericanDetached,
            TreeSpecies::Maple,
            TreeSpecies::Cedar,
        ),
        JurisdictionId::Germany => (
            BuildingStyle::EuropeanPerimeter,
            BuildingStyle::EuropeanPerimeter,
            TreeSpecies::LondonPlane,
            TreeSpecies::Cedar,
        ),
        JurisdictionId::Japan => (
            BuildingStyle::JapaneseCompact,
            BuildingStyle::JapaneseCompact,
            TreeSpecies::Cedar,
            TreeSpecies::Bamboo,
        ),
    };
    let buildings = (0..12)
        .map(|i| {
            let side = if i % 2 == 0 { -1.0 } else { 1.0 };
            let along = (i as f64 - 5.5) * 48.0;
            (
                format!("building/{}", i),
                [side * 42.0, 0.0, along],
                if i % 5 == 0 {
                    landmark_style
                } else {
                    primary_style
                },
            )
        })
        .collect::<Vec<_>>();
    let trees = (0..24)
        .map(|i| {
            let side = if i % 2 == 0 { -1.0 } else { 1.0 };
            let along = (i as f64 - 11.5) * 24.0;
            (
                format!("tree/{}", i),
                [side * 24.0, 0.0, along],
                if i % 3 == 0 { understory } else { street_tree },
            )
        })
        .collect::<Vec<_>>();
    NativeScene {
        format: "procedural-city-native".into(),
        version: 1,
        city,
        assets: populate_assets(config.seed, &buildings, &trees, 0.82),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        LaneUse,
        traffic::{JunctionKind, Marking},
        validate,
    };

    #[test]
    fn china_fixture_has_channelized_multilane_turns_and_signals() {
        let city = generate_demo_city(&GeneratorConfig::default());
        validate(&city).unwrap();
        let junction = &city.junctions[0];
        assert_eq!(junction.kind, JunctionKind::MultiPhaseSignal);
        assert!(junction.phases.len() >= 4);
        assert!(junction.signal_heads.len() >= 8);
        assert!(
            city.roads
                .iter()
                .flat_map(|r| r.lanes.iter())
                .flat_map(|lane| lane.markings.iter())
                .any(|m| matches!(
                    m,
                    Marking::Arrow {
                        style: crate::jurisdiction::ArrowStyle::ChinaGb,
                        arrow: crate::traffic::TurnArrow::Right
                    }
                ))
        );
        assert!(city.roads.iter().all(|road| {
            road.lanes
                .iter()
                .any(|lane| lane.use_kind == LaneUse::RightTurn)
        }));
    }
}
