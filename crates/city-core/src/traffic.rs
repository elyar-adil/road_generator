//! Deterministic lane, movement, marking and signal synthesis for junctions.
use crate::{
    LaneUse, Movement, SignalPhase,
    jurisdiction::{ArrowStyle, TrafficRules},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Marking {
    StopLine,
    Crosswalk,
    SolidEdge,
    DashedDivider,
    Arrow { style: ArrowStyle, arrow: TurnArrow },
    YieldTriangle,
    GuideLine,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum TurnArrow {
    Straight,
    Left,
    Right,
    StraightLeft,
    StraightRight,
    UTurn,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignalColor {
    Red,
    Yellow,
    Green,
    GreenArrow,
    FlashingYellow,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalHead {
    pub id: String,
    pub approach: String,
    pub lane_id: Option<String>,
    pub position_m: (f64, f64, f64),
    pub aspects: Vec<SignalColor>,
    pub countdown_s: Option<u16>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum JunctionKind {
    SimpleSignal,
    MultiPhaseSignal,
    Channelized,
    GradeSeparatedTerminal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApproachSpec {
    pub id: String,
    pub lanes_in: u8,
    pub lanes_out: u8,
    pub protected_left: bool,
    pub right_turn_lane: bool,
    pub pedestrian: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JunctionPlan {
    pub kind: JunctionKind,
    pub lanes: Vec<crate::Lane>,
    pub phases: Vec<SignalPhase>,
    pub markings: Vec<Marking>,
    pub conflict_pairs: Vec<(String, String)>,
    pub signal_heads: Vec<SignalHead>,
}

/// Build lane semantics before any mesh is made. The rightmost lane is a
/// dedicated right-turn lane when demand and road width justify it.
pub fn synthesize_junction(rules: &TrafficRules, approaches: &[ApproachSpec]) -> JunctionPlan {
    let mut lanes = Vec::new();
    let mut markings = vec![Marking::StopLine, Marking::Crosswalk];
    for approach in approaches {
        for i in 0..approach.lanes_in {
            let (use_kind, allowed, arrow) = if approach.right_turn_lane && i == 0 {
                (LaneUse::RightTurn, vec![Movement::Right], TurnArrow::Right)
            } else if approach.protected_left && i + 1 == approach.lanes_in {
                (LaneUse::LeftTurn, vec![Movement::Left], TurnArrow::Left)
            } else if approach.lanes_in >= 4 && i == 1 {
                (
                    LaneUse::Through,
                    vec![Movement::Through, Movement::Right],
                    TurnArrow::StraightRight,
                )
            } else {
                (
                    LaneUse::General,
                    vec![Movement::Through],
                    TurnArrow::Straight,
                )
            };
            lanes.push(crate::Lane {
                id: format!("{}/in/{}", approach.id, i),
                use_kind,
                allowed,
                width_m: rules.lane_width_m,
                index_from_curb: i,
                approach: approach.id.clone(),
                markings: vec![
                    Marking::Arrow {
                        style: rules.arrow_style,
                        arrow,
                    },
                    Marking::DashedDivider,
                ],
            });
        }
        if approach.pedestrian {
            markings.push(Marking::Crosswalk);
        }
    }
    let mut phases = Vec::new();
    for (i, approach) in approaches.iter().enumerate() {
        let movements = approach_movement_ids(approach);
        phases.push(SignalPhase {
            id: format!("phase-{}", i),
            duration_s: if approach.protected_left { 34.0 } else { 26.0 },
            movements,
            pedestrian: approach.pedestrian,
        });
    }
    if phases.len() < 2 {
        phases.push(SignalPhase {
            id: "phase-flash".into(),
            duration_s: 8.0,
            movements: vec![],
            pedestrian: false,
        });
    }
    let conflict_pairs = phases
        .iter()
        .enumerate()
        .flat_map(|(i, a)| {
            phases.iter().skip(i + 1).flat_map(move |b| {
                a.movements
                    .iter()
                    .flat_map(move |x| b.movements.iter().map(move |y| (x.clone(), y.clone())))
            })
        })
        .collect();
    let signal_heads = approaches
        .iter()
        .enumerate()
        .flat_map(|(i, approach)| {
            let x = (i as f64 - 1.5) * 18.0;
            let head = SignalHead {
                id: format!("signal/{}/vehicle", approach.id),
                approach: approach.id.clone(),
                lane_id: None,
                position_m: (x, 5.4, 0.0),
                aspects: vec![SignalColor::Red, SignalColor::Yellow, SignalColor::Green],
                countdown_s: Some(30),
            };
            let pedestrian = approach.pedestrian.then(|| SignalHead {
                id: format!("signal/{}/pedestrian", approach.id),
                approach: approach.id.clone(),
                lane_id: None,
                position_m: (x + 4.0, 2.8, 0.0),
                aspects: vec![SignalColor::Red, SignalColor::Green],
                countdown_s: Some(20),
            });
            std::iter::once(head).chain(pedestrian)
        })
        .collect();
    JunctionPlan {
        kind: if approaches
            .iter()
            .any(|a| a.protected_left || a.right_turn_lane)
        {
            JunctionKind::MultiPhaseSignal
        } else {
            JunctionKind::SimpleSignal
        },
        lanes,
        phases,
        markings,
        conflict_pairs,
        signal_heads,
    }
}

fn approach_movement_ids(approach: &ApproachSpec) -> Vec<String> {
    let mut result = Vec::new();
    if approach.protected_left {
        result.push(format!("{}/left", approach.id));
    }
    result.push(format!("{}/through", approach.id));
    if approach.right_turn_lane {
        result.push(format!("{}/right", approach.id));
    }
    result
}
