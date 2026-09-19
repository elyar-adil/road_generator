// Shared between the data exporter and the unlit semantic renderer.
export const SEMANTIC_COLORS = { road: 0x805080, marking: 0xfafafa, bridge: 0x8c8c9c,
  building: 0x4664c8, vegetation: 0x408040, sidewalk: 0xd4a0a0, block: 0x727a58, topology: 0x00dfff, water: 0x285aaa,
  furniture: 0x9aa4ad };
export const SEMANTIC_CLASSES = Object.entries(SEMANTIC_COLORS).map(([name, color], index) => ({
  id: index + 1, name, color: `#${color.toString(16).padStart(6, '0')}`,
}));
