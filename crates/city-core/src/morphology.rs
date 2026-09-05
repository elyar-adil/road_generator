//! Statistics used to calibrate and evaluate SD road graphs.
use crate::{CityDocument, RoadClass};
use glam::DVec2;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MorphologyPrior {
    pub mean_segment_m: f64,
    pub segment_cv: f64,
    pub mean_degree: f64,
    pub arterial_ratio: f64,
    pub highway_ratio: f64,
    pub orientation_entropy: f64,
    pub circuity: f64,
}

impl Default for MorphologyPrior {
    fn default() -> Self {
        Self {
            mean_segment_m: 110.0,
            segment_cv: 0.65,
            mean_degree: 2.7,
            arterial_ratio: 0.14,
            highway_ratio: 0.025,
            orientation_entropy: 0.68,
            circuity: 1.12,
        }
    }
}

impl MorphologyPrior {
    pub fn from_city(city: &CityDocument) -> Self {
        let stats = measure(city);
        Self {
            mean_segment_m: stats.mean_segment_m,
            segment_cv: stats.segment_cv,
            mean_degree: stats.mean_degree,
            arterial_ratio: stats.arterial_ratio,
            highway_ratio: stats.highway_ratio,
            orientation_entropy: stats.orientation_entropy,
            circuity: stats.circuity,
        }
    }
    pub fn score(&self, city: &CityDocument) -> f64 {
        let s = measure(city);
        let z = |a: f64, b: f64, scale: f64| ((a - b) / scale).powi(2);
        z(
            s.mean_segment_m,
            self.mean_segment_m,
            self.mean_segment_m.max(1.0) * 0.45,
        ) + z(s.segment_cv, self.segment_cv, 0.28)
            + z(s.mean_degree, self.mean_degree, 0.65)
            + z(s.arterial_ratio, self.arterial_ratio, 0.10)
            + z(s.highway_ratio, self.highway_ratio, 0.035)
            + z(s.orientation_entropy, self.orientation_entropy, 0.22)
            + z(s.circuity, self.circuity, 0.12)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct MorphologyStats {
    pub mean_segment_m: f64,
    pub segment_cv: f64,
    pub mean_degree: f64,
    pub arterial_ratio: f64,
    pub highway_ratio: f64,
    pub orientation_entropy: f64,
    pub circuity: f64,
}

pub fn measure(city: &CityDocument) -> MorphologyStats {
    let nodes = city
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.position_m))
        .collect::<std::collections::HashMap<_, _>>();
    let mut lengths = Vec::new();
    let mut bearings = Vec::new();
    let mut degree = std::collections::HashMap::<&str, usize>::new();
    let mut straight = 0.0;
    for road in &city.roads {
        let Some(a) = nodes.get(road.from_node.as_str()) else {
            continue;
        };
        let Some(b) = nodes.get(road.to_node.as_str()) else {
            continue;
        };
        let mut length = 0.0;
        for p in road.centerline.windows(2) {
            length += p[0].distance(p[1]);
        }
        let direct = a.distance(*b);
        if direct > 0.0 {
            straight += length / direct;
        }
        lengths.push(length);
        bearings.push(
            (b.y - a.y)
                .atan2(b.x - a.x)
                .rem_euclid(std::f64::consts::PI),
        );
        *degree.entry(road.from_node.as_str()).or_default() += 1;
        *degree.entry(road.to_node.as_str()).or_default() += 1;
    }
    let mean = lengths.iter().sum::<f64>() / lengths.len().max(1) as f64;
    let variance =
        lengths.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / lengths.len().max(1) as f64;
    let bins = 12;
    let mut histogram = vec![0.0; bins];
    for bearing in bearings {
        histogram[((bearing / std::f64::consts::PI) * bins as f64) as usize % bins] += 1.0;
    }
    let total = histogram.iter().sum::<f64>().max(1.0);
    let entropy = -histogram
        .iter()
        .filter(|x| **x > 0.0)
        .map(|x| {
            let p = x / total;
            p * p.ln()
        })
        .sum::<f64>()
        / (bins as f64).ln();
    MorphologyStats {
        mean_segment_m: mean,
        segment_cv: variance.sqrt() / mean.max(1.0),
        mean_degree: degree.values().sum::<usize>() as f64 / degree.len().max(1) as f64,
        arterial_ratio: city
            .roads
            .iter()
            .filter(|r| r.class == RoadClass::Arterial)
            .count() as f64
            / city.roads.len().max(1) as f64,
        highway_ratio: city
            .roads
            .iter()
            .filter(|r| r.class == RoadClass::Highway)
            .count() as f64
            / city.roads.len().max(1) as f64,
        orientation_entropy: entropy,
        circuity: straight / city.roads.len().max(1) as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::urban::{UrbanConfig, generate_urban_city};
    #[test]
    fn stats_are_finite_and_prior_scores_city() {
        let city = generate_urban_city(&UrbanConfig::default());
        let stats = measure(&city);
        assert!(stats.mean_segment_m.is_finite());
        assert!(MorphologyPrior::default().score(&city).is_finite());
    }
}
