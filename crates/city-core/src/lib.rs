//! Native procedural-city kernel. Rendering and editing are intentionally kept
//! outside this crate so the same deterministic scene can drive simulation,
//! sensors, offline export, and the editor.
use serde::{Deserialize, Serialize};

pub mod assets;
pub mod generator;
pub mod jurisdiction;
pub mod markings;
pub mod morphology;
pub mod probability;
pub mod scene;
pub mod traffic;
pub mod urban;
pub use glam::DVec2;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum RoadClass {
    Local,
    Collector,
    Arterial,
    Highway,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum LaneUse {
    General,
    LeftTurn,
    Through,
    RightTurn,
    UTurn,
    Bus,
    Bike,
    Shoulder,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Movement {
    Left,
    Through,
    Right,
    UTurn,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lane {
    pub id: String,
    pub use_kind: LaneUse,
    pub allowed: Vec<Movement>,
    pub width_m: f64,
    /// Position from the curb, in driving direction. Zero is the curb lane.
    pub index_from_curb: u8,
    pub approach: String,
    pub markings: Vec<traffic::Marking>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Road {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub class: RoadClass,
    pub centerline: Vec<DVec2>,
    pub lanes: Vec<Lane>,
    pub layer: i8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CityNode {
    pub id: String,
    pub position_m: DVec2,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalPhase {
    pub id: String,
    pub duration_s: f32,
    pub movements: Vec<String>,
    pub pedestrian: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Junction {
    pub id: String,
    pub roads: Vec<String>,
    pub phases: Vec<SignalPhase>,
    pub markings: Vec<traffic::Marking>,
    pub kind: traffic::JunctionKind,
    pub signal_heads: Vec<traffic::SignalHead>,
    pub conflict_pairs: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CityDocument {
    pub version: u32,
    pub jurisdiction: String,
    pub seed: u64,
    pub nodes: Vec<CityNode>,
    pub roads: Vec<Road>,
    pub junctions: Vec<Junction>,
}

pub fn validate(doc: &CityDocument) -> Result<(), String> {
    if doc.version == 0 {
        return Err("unsupported city document version".into());
    }
    if doc.jurisdiction.is_empty() {
        return Err("jurisdiction is required".into());
    }
    if doc
        .roads
        .iter()
        .any(|r| r.centerline.len() < 2 || r.lanes.is_empty())
    {
        return Err("road geometry or lanes are incomplete".into());
    }
    let road_ids: std::collections::HashSet<_> = doc.roads.iter().map(|r| r.id.as_str()).collect();
    if road_ids.len() != doc.roads.len() {
        return Err("duplicate road id".into());
    }
    let node_ids: std::collections::HashSet<_> = doc.nodes.iter().map(|n| n.id.as_str()).collect();
    if node_ids.len() != doc.nodes.len() {
        return Err("duplicate node id".into());
    }
    for road in &doc.roads {
        if !node_ids.contains(road.from_node.as_str()) || !node_ids.contains(road.to_node.as_str())
        {
            return Err(format!("road {} references unknown node", road.id));
        }
        let mut lane_ids = std::collections::HashSet::new();
        for lane in &road.lanes {
            if lane.width_m < 2.5 || lane.width_m > 5.0 {
                return Err(format!("lane {} has invalid width", lane.id));
            }
            if !lane_ids.insert(lane.id.as_str()) {
                return Err(format!("duplicate lane id {}", lane.id));
            }
        }
    }
    Ok(())
}
