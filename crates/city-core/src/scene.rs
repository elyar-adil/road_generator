//! Renderer-neutral scene descriptors. A native renderer expands these into
//! meshes, materials and instances; simulation and sensor backends consume the
//! same semantic IDs.
use crate::CityDocument;
use crate::assets::{
    BuildingProfile, BuildingStyle, TreeProfile, TreeSpecies, sample_building, sample_tree,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Lod {
    Hero,
    Near,
    Mid,
    Far,
    Billboard,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SurfaceShader {
    Asphalt,
    Concrete,
    Glass,
    Brick,
    Stucco,
    RoofTile,
    Leaf,
    Bark,
    Water,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaterialDescriptor {
    pub name: String,
    pub shader: SurfaceShader,
    pub base_color: [f32; 4],
    pub roughness: f32,
    pub metallic: f32,
    pub normal_scale: f32,
    pub detail_scale_m: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildingInstance {
    pub id: String,
    pub profile: BuildingProfile,
    pub position_m: [f64; 3],
    pub rotation_rad: f32,
    pub lod: Lod,
    pub material_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeInstance {
    pub id: String,
    pub profile: TreeProfile,
    pub position_m: [f64; 3],
    pub rotation_rad: f32,
    pub lod: Lod,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SceneAssets {
    pub materials: Vec<MaterialDescriptor>,
    pub buildings: Vec<BuildingInstance>,
    pub trees: Vec<TreeInstance>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NativeScene {
    pub format: String,
    pub version: u32,
    pub city: CityDocument,
    pub assets: SceneAssets,
}

impl Default for SceneAssets {
    fn default() -> Self {
        Self {
            materials: vec![
                MaterialDescriptor {
                    name: "asphalt/wet".into(),
                    shader: SurfaceShader::Asphalt,
                    base_color: [0.035, 0.042, 0.048, 1.0],
                    roughness: 0.68,
                    metallic: 0.02,
                    normal_scale: 0.85,
                    detail_scale_m: 2.0,
                },
                MaterialDescriptor {
                    name: "glass/low-e".into(),
                    shader: SurfaceShader::Glass,
                    base_color: [0.12, 0.22, 0.28, 1.0],
                    roughness: 0.12,
                    metallic: 0.4,
                    normal_scale: 0.15,
                    detail_scale_m: 1.0,
                },
                MaterialDescriptor {
                    name: "facade/concrete".into(),
                    shader: SurfaceShader::Concrete,
                    base_color: [0.46, 0.48, 0.48, 1.0],
                    roughness: 0.82,
                    metallic: 0.0,
                    normal_scale: 0.65,
                    detail_scale_m: 0.8,
                },
                MaterialDescriptor {
                    name: "vegetation/leaf".into(),
                    shader: SurfaceShader::Leaf,
                    base_color: [0.06, 0.23, 0.09, 1.0],
                    roughness: 0.9,
                    metallic: 0.0,
                    normal_scale: 0.35,
                    detail_scale_m: 0.3,
                },
            ],
            buildings: Vec::new(),
            trees: Vec::new(),
        }
    }
}

/// Expand semantic district points into deterministic asset descriptors. The
/// caller supplies the region's style; geometry remains a renderer concern.
pub fn populate_assets(
    seed: u64,
    points: &[(String, [f64; 3], BuildingStyle)],
    tree_points: &[(String, [f64; 3], TreeSpecies)],
    density: f32,
) -> SceneAssets {
    let mut assets = SceneAssets::default();
    for (i, (id, position, style)) in points.iter().enumerate() {
        let profile = sample_building(
            *style,
            seed ^ (i as u64).wrapping_mul(0x9e3779b97f4a7c15),
            density,
        );
        let lod = if profile.floors > 20 {
            Lod::Near
        } else {
            Lod::Mid
        };
        assets.buildings.push(BuildingInstance {
            id: id.clone(),
            profile,
            position_m: *position,
            rotation_rad: ((i as f32 * 1.618) % 6.283),
            lod,
            material_ids: vec!["facade/concrete".into(), "glass/low-e".into()],
        });
    }
    for (i, (id, position, species)) in tree_points.iter().enumerate() {
        let profile = sample_tree(
            *species,
            seed.wrapping_add((i as u64).wrapping_mul(0x517cc1b727220a95)),
        );
        assets.trees.push(TreeInstance {
            id: id.clone(),
            profile,
            position_m: *position,
            rotation_rad: (i as f32 * 2.399) % 6.283,
            lod: Lod::Near,
        });
    }
    assets
}
