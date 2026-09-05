//! Traffic and streetscape conventions are data, not hard-coded geometry.
//! A renderer can use the same semantic scene with a different profile.
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum JurisdictionId {
    ChinaMainland,
    UnitedStates,
    Germany,
    Japan,
}

impl fmt::Display for JurisdictionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ChinaMainland => "china",
            Self::UnitedStates => "usa",
            Self::Germany => "germany",
            Self::Japan => "japan",
        })
    }
}

impl FromStr for JurisdictionId {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "cn" | "china" | "china-mainland" => Ok(Self::ChinaMainland),
            "us" | "usa" | "united-states" => Ok(Self::UnitedStates),
            "de" | "germany" => Ok(Self::Germany),
            "jp" | "japan" => Ok(Self::Japan),
            other => Err(format!("unknown jurisdiction: {other}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum DrivingSide {
    Right,
    Left,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignalStyle {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ArrowStyle {
    ChinaGb,
    Vienna,
    NorthAmerica,
    Japan,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrafficRules {
    pub jurisdiction: JurisdictionId,
    pub driving_side: DrivingSide,
    pub signal_style: SignalStyle,
    pub arrow_style: ArrowStyle,
    pub lane_width_m: f64,
    pub stop_line_offset_m: f64,
    pub crosswalk_width_m: f64,
    pub default_right_turn_yield: bool,
    pub right_turn_on_red: bool,
    pub yellow_duration_s: f32,
}

impl TrafficRules {
    pub fn for_jurisdiction(jurisdiction: JurisdictionId) -> Self {
        match jurisdiction {
            JurisdictionId::ChinaMainland => Self {
                jurisdiction,
                driving_side: DrivingSide::Right,
                signal_style: SignalStyle::Vertical,
                arrow_style: ArrowStyle::ChinaGb,
                lane_width_m: 3.25,
                stop_line_offset_m: 3.0,
                crosswalk_width_m: 4.0,
                default_right_turn_yield: true,
                right_turn_on_red: true,
                yellow_duration_s: 3.0,
            },
            JurisdictionId::UnitedStates => Self {
                jurisdiction,
                driving_side: DrivingSide::Right,
                signal_style: SignalStyle::Horizontal,
                arrow_style: ArrowStyle::NorthAmerica,
                lane_width_m: 3.6,
                stop_line_offset_m: 3.6,
                crosswalk_width_m: 3.0,
                default_right_turn_yield: true,
                right_turn_on_red: true,
                yellow_duration_s: 4.0,
            },
            JurisdictionId::Germany => Self {
                jurisdiction,
                driving_side: DrivingSide::Right,
                signal_style: SignalStyle::Vertical,
                arrow_style: ArrowStyle::Vienna,
                lane_width_m: 3.25,
                stop_line_offset_m: 3.0,
                crosswalk_width_m: 3.0,
                default_right_turn_yield: false,
                right_turn_on_red: false,
                yellow_duration_s: 3.0,
            },
            JurisdictionId::Japan => Self {
                jurisdiction,
                driving_side: DrivingSide::Left,
                signal_style: SignalStyle::Vertical,
                arrow_style: ArrowStyle::Japan,
                lane_width_m: 3.0,
                stop_line_offset_m: 2.5,
                crosswalk_width_m: 4.0,
                default_right_turn_yield: false,
                right_turn_on_red: false,
                yellow_duration_s: 3.0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_are_stable_and_profiles_differ() {
        assert_eq!(
            "cn".parse::<JurisdictionId>().unwrap(),
            JurisdictionId::ChinaMainland
        );
        assert_eq!(
            "japan".parse::<JurisdictionId>().unwrap().to_string(),
            "japan"
        );
        assert_ne!(
            TrafficRules::for_jurisdiction(JurisdictionId::ChinaMainland).arrow_style,
            TrafficRules::for_jurisdiction(JurisdictionId::UnitedStates).arrow_style
        );
    }
}
