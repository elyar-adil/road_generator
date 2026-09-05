//! A deterministic, multi-scale urban graph generator. It deliberately emits
//! topology and centerlines only; lane markings, signals and meshes are later
//! derived from the same graph.
use crate::jurisdiction::{JurisdictionId, TrafficRules};
use crate::morphology::MorphologyPrior;
use crate::probability::{ActionKind, GrowthState, ModelWeights, sample_action};
use crate::traffic::{ApproachSpec, JunctionKind, Marking, synthesize_junction};
use crate::{CityDocument, CityNode, Junction, Lane, LaneUse, Movement, Road, RoadClass};
use glam::DVec2;
use rand::{Rng, SeedableRng, rngs::StdRng};

#[derive(Clone, Debug)]
pub struct UrbanConfig {
    pub seed: u64,
    pub size_m: f64,
    pub centers: usize,
    pub local_roads_per_center: usize,
    pub jurisdiction: JurisdictionId,
    pub morphology_prior: MorphologyPrior,
}

impl Default for UrbanConfig {
    fn default() -> Self {
        Self {
            seed: 42,
            size_m: 2400.0,
            centers: 5,
            local_roads_per_center: 12,
            jurisdiction: JurisdictionId::ChinaMainland,
            morphology_prior: MorphologyPrior::default(),
        }
    }
}

pub fn generate_urban_city(config: &UrbanConfig) -> CityDocument {
    let mut best = None;
    for attempt in 0..8u64 {
        let mut candidate_config = config.clone();
        candidate_config.seed = config
            .seed
            .wrapping_add(attempt.wrapping_mul(0x9e3779b97f4a7c15));
        let candidate = generate_urban_candidate(&candidate_config);
        let score = config.morphology_prior.score(&candidate);
        if best
            .as_ref()
            .map(|(best_score, _): &(f64, CityDocument)| score < *best_score)
            .unwrap_or(true)
        {
            best = Some((score, candidate));
        }
    }
    best.expect("at least one SD candidate").1
}

fn generate_urban_candidate(config: &UrbanConfig) -> CityDocument {
    let mut rng = StdRng::seed_from_u64(config.seed);
    let rules = TrafficRules::for_jurisdiction(config.jurisdiction);
    let half = config.size_m * 0.5;
    let mut nodes = Vec::new();
    let mut centers = Vec::new();
    for i in 0..config.centers.max(1) {
        let mut p;
        let mut tries = 0;
        loop {
            let angle = rng.random_range(0.0..std::f64::consts::TAU);
            let radius = rng.random_range(0.0..half * 0.58)
                * (0.6 + i as f64 / config.centers.max(1) as f64 * 0.4);
            p = DVec2::new(angle.cos() * radius, angle.sin() * radius);
            tries += 1;
            if centers
                .iter()
                .all(|(_, q): &(String, DVec2)| p.distance(*q) > half * 0.23)
                || tries > 30
            {
                break;
            }
        }
        let id = format!("center/{}", i);
        nodes.push(CityNode {
            id: id.clone(),
            position_m: p,
            role: if i == 0 {
                "core".into()
            } else {
                "district".into()
            },
        });
        centers.push((id, p));
    }
    let mut roads = Vec::new();
    let mut elevated_ids = Vec::new();
    let mut junction_roads: Vec<Vec<String>> = vec![Vec::new(); centers.len()];
    let mut road_index = 0;
    let mut add_road =
        |from: &str, to: &str, class: RoadClass, points: Vec<DVec2>, lanes: Vec<Lane>| {
            road_index += 1;
            let id = format!("road/{road_index}");
            roads.push(Road {
                id: id.clone(),
                from_node: from.into(),
                to_node: to.into(),
                class,
                centerline: points,
                lanes,
                layer: 0,
            });
            id
        };
    let lanes_for = |approach: &str, class: RoadClass| {
        let count = match class {
            RoadClass::Highway => 5,
            RoadClass::Arterial => 4,
            RoadClass::Collector => 3,
            _ => 1,
        };
        (0..count)
            .map(|i| Lane {
                id: format!("{approach}/lane/{i}"),
                use_kind: if count > 2 && i == 0 {
                    LaneUse::RightTurn
                } else {
                    LaneUse::General
                },
                allowed: if count > 2 && i == 0 {
                    vec![Movement::Right]
                } else {
                    vec![Movement::Through]
                },
                width_m: rules.lane_width_m,
                index_from_curb: i,
                approach: approach.into(),
                markings: vec![
                    Marking::Arrow {
                        style: rules.arrow_style,
                        arrow: if i == 0 {
                            crate::traffic::TurnArrow::Right
                        } else {
                            crate::traffic::TurnArrow::Straight
                        },
                    },
                    Marking::DashedDivider,
                ],
            })
            .collect::<Vec<_>>()
    };
    // Connect every district to its nearest older district. Curved centerlines
    // retain organic variation without destroying long-range accessibility.
    for i in 1..centers.len() {
        let (id, p) = &centers[i];
        let (parent_i, parent) = centers[..i]
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| p.distance(a.1).partial_cmp(&p.distance(b.1)).unwrap())
            .unwrap();
        let bend = DVec2::new(rng.random_range(-90.0..90.0), rng.random_range(-90.0..90.0));
        let points = vec![parent.1, (parent.1 + *p) * 0.5 + bend, *p];
        let rid = add_road(
            &parent.0,
            id,
            RoadClass::Arterial,
            points,
            lanes_for(&format!("district-{i}"), RoadClass::Arterial),
        );
        junction_roads[parent_i].push(rid.clone());
        junction_roads[i].push(rid);
    }
    // Regional mobility is generated as a small choice set of candidate
    // corridors. The selected corridors are long, smooth, and sparse; ramps
    // connect them to nearby districts, producing the hierarchy visible in a
    // real map instead of turning every street into a local spoke.
    let boundary = [
        (
            "gateway/west",
            DVec2::new(-half * 0.98, rng.random_range(-half * 0.55..half * 0.55)),
        ),
        (
            "gateway/east",
            DVec2::new(half * 0.98, rng.random_range(-half * 0.55..half * 0.55)),
        ),
        (
            "gateway/north",
            DVec2::new(rng.random_range(-half * 0.55..half * 0.55), -half * 0.98),
        ),
        (
            "gateway/south",
            DVec2::new(rng.random_range(-half * 0.55..half * 0.55), half * 0.98),
        ),
    ];
    for (id, position) in boundary {
        nodes.push(CityNode {
            id: id.into(),
            position_m: position,
            role: "regional-gateway".into(),
        });
    }
    let corridor_options = [
        (
            "gateway/west",
            "gateway/east",
            DVec2::new(0.0, -half * 0.18),
        ),
        ("gateway/west", "gateway/east", DVec2::new(0.0, half * 0.26)),
        (
            "gateway/north",
            "gateway/south",
            DVec2::new(-half * 0.22, 0.0),
        ),
        (
            "gateway/north",
            "gateway/south",
            DVec2::new(half * 0.30, 0.0),
        ),
    ];
    let corridor_candidates = corridor_options
        .iter()
        .map(|(_, _, bend)| crate::probability::ActionCandidate {
            kind: ActionKind::Connect,
            accessibility_gain: 1.0 + bend.length() / half,
            served_demand: 0.65,
            continuity: 0.95,
            block_gain: 0.08,
            construction_cost: 0.78,
            morphology_penalty: 0.18,
            feasible: true,
        })
        .collect::<Vec<_>>();
    let chosen_corridor =
        sample_action(&corridor_candidates, ModelWeights::default(), &mut rng).unwrap_or(0);
    for (index, (from, to, bend)) in corridor_options.iter().enumerate() {
        if index != chosen_corridor && (index + chosen_corridor) % 3 != 0 {
            continue;
        }
        let a = nodes.iter().find(|n| n.id == *from).unwrap().position_m;
        let b = nodes.iter().find(|n| n.id == *to).unwrap().position_m;
        let mid = (a + b) * 0.5 + *bend;
        let rid = add_road(
            from,
            to,
            RoadClass::Highway,
            vec![a, mid, b],
            lanes_for(&format!("highway-{index}"), RoadClass::Highway),
        );
        let nearest = centers
            .iter()
            .enumerate()
            .min_by(|(_, x), (_, y)| mid.distance(x.1).partial_cmp(&mid.distance(y.1)).unwrap())
            .map(|(i, _)| i)
            .unwrap_or(0);
        junction_roads[nearest].push(rid.clone());
        let ramp_node = format!("node/interchange/{index}");
        let ramp_position = mid + DVec2::new(-bend.y, bend.x).normalize_or_zero() * 62.0;
        nodes.push(CityNode {
            id: ramp_node.clone(),
            position_m: ramp_position,
            role: "interchange-ramp-terminal".into(),
        });
        let ramp = add_road(
            &ramp_node,
            &centers[nearest].0,
            RoadClass::Arterial,
            vec![
                ramp_position,
                (ramp_position + centers[nearest].1) * 0.5,
                centers[nearest].1,
            ],
            lanes_for(&format!("ramp-{index}"), RoadClass::Arterial),
        );
        elevated_ids.push((ramp.clone(), if index % 2 == 0 { 1 } else { -1 }));
        junction_roads[nearest].push(ramp);
    }
    // Local streets are grown from a stochastic frontier. The model chooses
    // between extending, closing a block, and upgrading a corridor after
    // scoring accessibility, demand, continuity, construction cost and the
    // shape penalty of the proposed segment. There is no pre-drawn grid.
    for (ci, (center_id, center)) in centers.iter().enumerate() {
        let mut growth = GrowthState::new(0.82 - ci as f64 * 0.08);
        let orientation = rng.random_range(0.0..std::f64::consts::TAU);
        let mut frontier = vec![(center_id.clone(), *center, orientation)];
        let iterations = config.local_roads_per_center.max(10) * 3;
        for step in 0..iterations {
            if frontier.is_empty() {
                break;
            }
            let anchor_index = if step % 4 == 0 {
                rng.random_range(0..frontier.len())
            } else {
                frontier.len() - 1
            };
            let (from, p, previous_angle) = frontier[anchor_index].clone();
            let local_angle = previous_angle
                + rng.random_range(-0.62..0.62)
                + (orientation - previous_angle) * 0.18;
            let length = rng.random_range(58.0..150.0) * (1.0 - ci as f64 * 0.025);
            let wanted = p + DVec2::new(local_angle.cos(), local_angle.sin()) * length;
            if wanted.x.abs() > half * 0.94 || wanted.y.abs() > half * 0.94 {
                continue;
            }
            let candidates = [
                growth.candidate(ActionKind::Extend, 0.25, 0.18, 0.12),
                growth.candidate(ActionKind::CloseBlock, 0.72, 0.34, 0.16),
                growth.candidate(
                    ActionKind::Upgrade,
                    if step % 7 == 0 { 0.9 } else { 0.05 },
                    0.82,
                    0.42,
                ),
            ];
            let selected =
                sample_action(&candidates, ModelWeights::default(), &mut rng).unwrap_or(0);
            let action = candidates[selected];
            growth.apply(&action);
            let mut target = None;
            if action.kind == ActionKind::CloseBlock || rng.random::<f64>() < 0.22 {
                target = nodes
                    .iter()
                    .filter(|n| n.id != from && n.position_m.distance(wanted) < length * 1.25)
                    .min_by(|a, b| {
                        a.position_m
                            .distance(wanted)
                            .partial_cmp(&b.position_m.distance(wanted))
                            .unwrap()
                    })
                    .map(|n| (n.id.clone(), n.position_m));
            }
            let (to, q, is_new) = target.map(|(id, q)| (id, q, false)).unwrap_or_else(|| {
                let id = format!("node/{ci}/growth/{step}");
                nodes.push(CityNode {
                    id: id.clone(),
                    position_m: wanted,
                    role: "grown-junction".into(),
                });
                (id, wanted, true)
            });
            let class = match action.kind {
                ActionKind::Upgrade => RoadClass::Arterial,
                ActionKind::CloseBlock => RoadClass::Collector,
                _ => RoadClass::Local,
            };
            let tangent = DVec2::new(-(q.y - p.y), q.x - p.x).normalize_or_zero();
            let bend = tangent * rng.random_range(-18.0..18.0);
            let rid = add_road(
                &from,
                &to,
                class,
                vec![p, (p + q) * 0.5 + bend, q],
                lanes_for(&format!("{ci}-growth-{step}"), class),
            );
            if class != RoadClass::Local {
                junction_roads[ci].push(rid);
            }
            if is_new || rng.random::<f64>() < 0.35 {
                frontier.push((to, q, local_angle + rng.random_range(-0.18..0.18)));
            }
            if frontier.len() > 8 + config.local_roads_per_center * 2 {
                frontier.remove(anchor_index.min(frontier.len() - 1));
            }
        }
    }
    drop(add_road);
    for (id, layer) in elevated_ids {
        if let Some(road) = roads.iter_mut().find(|road| road.id == id) {
            road.layer = layer;
        }
    }
    let mut junctions = Vec::new();
    for (i, road_ids) in junction_roads.iter().enumerate() {
        let approaches = (0..road_ids.len().min(8))
            .map(|j| ApproachSpec {
                id: format!("center-{i}-{j}"),
                lanes_in: if j % 3 == 0 { 4 } else { 3 },
                lanes_out: 3,
                protected_left: i == 0 || j % 4 == 0,
                right_turn_lane: true,
                pedestrian: true,
            })
            .collect::<Vec<_>>();
        let plan = synthesize_junction(&rules, &approaches);
        junctions.push(Junction {
            id: format!("junction/{}", i),
            roads: road_ids.clone(),
            phases: plan.phases,
            markings: plan.markings,
            kind: if plan.kind == JunctionKind::SimpleSignal {
                JunctionKind::Channelized
            } else {
                plan.kind
            },
            signal_heads: plan.signal_heads,
            conflict_pairs: plan.conflict_pairs,
        });
    }
    CityDocument {
        version: 1,
        jurisdiction: config.jurisdiction.to_string(),
        seed: config.seed,
        nodes,
        roads,
        junctions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate;

    #[test]
    fn city_is_multi_centre_connected_and_reproducible() {
        let config = UrbanConfig::default();
        let a = generate_urban_city(&config);
        let b = generate_urban_city(&config);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        assert!(a.nodes.len() > config.centers);
        assert!(a.roads.len() >= config.centers * 10);
        assert!(a.junctions.len() >= config.centers);
        validate(&a).unwrap();
    }
}
