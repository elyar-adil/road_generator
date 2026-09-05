//! Metric road-marking geometry. The jurisdiction selects the arrow stencil,
//! while this module returns world-space vertices for any renderer.
use crate::jurisdiction::ArrowStyle;
use crate::traffic::TurnArrow;
use glam::DVec2;

pub fn stop_line(center: DVec2, tangent: DVec2, width_m: f64) -> Vec<DVec2> {
    let t = tangent.normalize_or_zero();
    let n = DVec2::new(-t.y, t.x) * (width_m * 0.5);
    vec![center - n, center + n]
}

pub fn crosswalk_stripes(
    center: DVec2,
    tangent: DVec2,
    road_width_m: f64,
    stripe_width_m: f64,
    gap_m: f64,
) -> Vec<[DVec2; 4]> {
    let t = tangent.normalize_or_zero();
    let n = DVec2::new(-t.y, t.x);
    let count = (road_width_m / (stripe_width_m + gap_m)).floor().max(1.0) as usize;
    (0..count)
        .map(|i| {
            let offset = (i as f64 - (count as f64 - 1.0) * 0.5) * (stripe_width_m + gap_m);
            let c = center + n * offset;
            let a = c - t * (road_width_m * 0.5);
            let b = c + t * (road_width_m * 0.5);
            let w = n * (stripe_width_m * 0.5);
            [a - w, b - w, b + w, a + w]
        })
        .collect()
}

/// Returns a unit arrow stencil in local coordinates. Production renderers
/// can replace the tessellator while preserving the legal semantic arrow.
pub fn arrow_stencil(style: ArrowStyle, arrow: TurnArrow, scale_m: f64) -> Vec<DVec2> {
    let shoulder = match style {
        ArrowStyle::ChinaGb => 0.18,
        ArrowStyle::Vienna => 0.16,
        ArrowStyle::NorthAmerica => 0.20,
        ArrowStyle::Japan => 0.17,
    } * scale_m;
    let shaft = 0.12 * scale_m;
    let head = 0.36 * scale_m;
    let mut points = vec![
        DVec2::new(-shaft, -scale_m),
        DVec2::new(shaft, -scale_m),
        DVec2::new(shaft, scale_m * 0.18),
        DVec2::new(shoulder, scale_m * 0.18),
        DVec2::new(0.0, scale_m),
        DVec2::new(-shoulder, scale_m * 0.18),
        DVec2::new(-shaft, scale_m * 0.18),
    ];
    match arrow {
        TurnArrow::Straight => {}
        TurnArrow::Left
        | TurnArrow::Right
        | TurnArrow::StraightLeft
        | TurnArrow::StraightRight
        | TurnArrow::UTurn => {
            // A compact branch is appended to the stencil; the renderer rotates
            // it for the driving side and can apply the country's exact glyph.
            let side = if matches!(
                arrow,
                TurnArrow::Left | TurnArrow::StraightLeft | TurnArrow::UTurn
            ) {
                -1.0
            } else {
                1.0
            };
            points.extend([
                DVec2::new(0.0, 0.0),
                DVec2::new(side * head, -head),
                DVec2::new(side * head, head),
            ]);
        }
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markings_are_metric_and_deterministic() {
        assert_eq!(stop_line(DVec2::ZERO, DVec2::X, 12.0).len(), 2);
        assert!(crosswalk_stripes(DVec2::ZERO, DVec2::X, 12.0, 0.5, 0.5).len() >= 6);
        assert!(arrow_stencil(ArrowStyle::ChinaGb, TurnArrow::Right, 3.0).len() > 7);
    }
}
