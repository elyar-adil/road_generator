//! Reproducible constrained stochastic primitives for urban growth.
use rand::Rng;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Extend,
    Connect,
    CloseBlock,
    CrossBarrier,
    Upgrade,
    Stop,
}

#[derive(Clone, Copy, Debug)]
pub struct ActionCandidate {
    pub kind: ActionKind,
    pub accessibility_gain: f64,
    pub served_demand: f64,
    pub continuity: f64,
    pub block_gain: f64,
    pub construction_cost: f64,
    pub morphology_penalty: f64,
    pub feasible: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ModelWeights {
    pub accessibility: f64,
    pub demand: f64,
    pub continuity: f64,
    pub block_gain: f64,
    pub cost: f64,
    pub morphology: f64,
    pub temperature: f64,
}

#[derive(Clone, Debug)]
pub struct GrowthState {
    pub accessibility: f64,
    pub unmet_demand: f64,
    pub completed_blocks: f64,
    pub construction_budget: f64,
}

impl GrowthState {
    pub fn new(demand: f64) -> Self {
        Self {
            accessibility: 0.12,
            unmet_demand: demand.max(0.0),
            completed_blocks: 0.0,
            construction_budget: 1.0,
        }
    }
    pub fn candidate(
        &self,
        kind: ActionKind,
        continuity: f64,
        cost: f64,
        morphology: f64,
    ) -> ActionCandidate {
        let demand = self.unmet_demand.min(1.0);
        let (accessibility_gain, served_demand, block_gain) = match kind {
            ActionKind::Connect => (0.9 * (1.0 - self.accessibility), 0.9 * demand, 0.2),
            ActionKind::CloseBlock => (0.42, 0.5 * demand, 0.95),
            ActionKind::Extend => (0.32, 0.35 * demand, 0.5),
            ActionKind::CrossBarrier => (1.15, 1.1 * demand, 0.1),
            ActionKind::Upgrade => (0.72, 0.72 * demand, 0.15),
            ActionKind::Stop => (0.0, 0.0, 0.0),
        };
        ActionCandidate {
            kind,
            accessibility_gain,
            served_demand,
            continuity,
            block_gain,
            construction_cost: cost,
            morphology_penalty: morphology,
            feasible: cost <= self.construction_budget || kind == ActionKind::Stop,
        }
    }
    pub fn apply(&mut self, action: &ActionCandidate) {
        self.accessibility = (self.accessibility + action.accessibility_gain * 0.08).min(1.0);
        self.unmet_demand = (self.unmet_demand - action.served_demand * 0.06).max(0.0);
        self.completed_blocks += action.block_gain * 0.04;
        self.construction_budget =
            (self.construction_budget - action.construction_cost * 0.012).max(0.18);
    }
}

impl Default for ModelWeights {
    fn default() -> Self {
        Self {
            accessibility: 1.6,
            demand: 1.2,
            continuity: 0.8,
            block_gain: 0.7,
            cost: 0.9,
            morphology: 1.1,
            temperature: 0.42,
        }
    }
}

impl ActionCandidate {
    pub fn utility(self, weights: ModelWeights) -> f64 {
        weights.accessibility * self.accessibility_gain
            + weights.demand * self.served_demand
            + weights.continuity * self.continuity
            + weights.block_gain * self.block_gain
            - weights.cost * self.construction_cost
            - weights.morphology * self.morphology_penalty
    }
}

pub fn probabilities(candidates: &[ActionCandidate], weights: ModelWeights) -> Vec<f64> {
    let mut result = vec![0.0; candidates.len()];
    let feasible: Vec<_> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.feasible)
        .collect();
    if feasible.is_empty() {
        return result;
    }
    let max_u = feasible
        .iter()
        .map(|(_, c)| c.utility(weights))
        .fold(f64::NEG_INFINITY, f64::max);
    let temperature = weights.temperature.max(0.01);
    let mut total = 0.0;
    for (i, candidate) in feasible {
        let value = ((candidate.utility(weights) - max_u) / temperature).exp();
        result[i] = value;
        total += value;
    }
    if total > 0.0 {
        result.iter_mut().for_each(|p| *p /= total);
    }
    result
}

pub fn sample_action<R: Rng + ?Sized>(
    candidates: &[ActionCandidate],
    weights: ModelWeights,
    rng: &mut R,
) -> Option<usize> {
    let probabilities = probabilities(candidates, weights);
    let mut cursor = rng.random::<f64>();
    for (i, probability) in probabilities.iter().enumerate() {
        cursor -= probability;
        if cursor <= 0.0 {
            return Some(i);
        }
    }
    probabilities.iter().rposition(|p| *p > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    fn candidate(gain: f64, feasible: bool) -> ActionCandidate {
        ActionCandidate {
            kind: ActionKind::Extend,
            accessibility_gain: gain,
            served_demand: gain,
            continuity: 0.0,
            block_gain: 0.0,
            construction_cost: 0.0,
            morphology_penalty: 0.0,
            feasible,
        }
    }

    #[test]
    fn high_utility_action_has_higher_probability_and_invalid_is_zero() {
        let p = probabilities(
            &[
                candidate(1.0, true),
                candidate(4.0, true),
                candidate(20.0, false),
            ],
            ModelWeights::default(),
        );
        assert!(p[1] > p[0]);
        assert_eq!(p[2], 0.0);
        assert!((p[0] + p[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn sampling_is_reproducible() {
        let candidates = [candidate(1.0, true), candidate(2.0, true)];
        let mut a = StdRng::seed_from_u64(99);
        let mut b = StdRng::seed_from_u64(99);
        let x: Vec<_> = (0..20)
            .map(|_| sample_action(&candidates, ModelWeights::default(), &mut a))
            .collect();
        let y: Vec<_> = (0..20)
            .map(|_| sample_action(&candidates, ModelWeights::default(), &mut b))
            .collect();
        assert_eq!(x, y);
    }

    #[test]
    fn state_feedback_reduces_unmet_demand_after_building() {
        let mut state = GrowthState::new(1.0);
        let action = state.candidate(ActionKind::Connect, 0.8, 0.2, 0.1);
        let before = state.unmet_demand;
        state.apply(&action);
        assert!(state.unmet_demand < before);
        assert!(state.accessibility > 0.12);
    }
}
