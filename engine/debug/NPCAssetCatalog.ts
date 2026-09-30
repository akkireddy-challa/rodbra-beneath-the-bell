// Type checking enabled
// Shared NPC asset catalog for all game modes
// Provides URLs and metadata for pre-generated NPCs, matching the C# MiniNPCGenerator

// URL format: https://storage.googleapis.com/forged-assets/{id}/output.glb

export const PREGENERATED_NPC_DESCRIPTIONS = [
  { id: 'BDRPLBYJ', defaultScale: 1.65, name: 'Wise old man', description: 'Wise old man, white skin' },
  { id: 'LLNNWNAF', name: 'Farmer', description: 'Farmer, white male, yellow shirt, hat, white skin' },
  { id: 'WOQBOJSE', name: 'Ninja', description: 'Ninja, face covered, hood, robe' },
  { id: 'WVUKGSTX', name: 'Elf', description: 'Elf, pointy ears, red cape, white robe' },
  { id: 'JYZYVTXG', defaultScale: 1.6, name: 'Robot', description: 'Robot, metallic, white and black' },
  { id: 'GKTJSUXH', defaultScale: 1.3, name: 'Child 1', description: 'Young girl, white skin, child, pink shirt, white shorts' },
  { id: 'XETTHLIR', defaultScale: 1.4, name: 'Child 2', description: 'Young boy, caucasian, dark hair, child, white t-shirt' },
  { id: 'RQVJDMSW', defaultScale: 1.65, name: 'Female 1', description: 'Adult woman, caucasian, dark hair, white shirt, blue shorts' },
  { id: 'ZKYVLOVK', name: 'Male 1', description: 'Adult man, caucasian, dark hair, red t-shirt, blue jeans' },
  { id: 'AZOEISDQ', name: 'Female 2', description: 'Caucasian woman, blond hair, adult, white shirt, blue shorts' },
  { id: 'SUYFEVQF', name: 'Male 2', description: 'Caucasian man, adult, blond hair, white shirt, blue jeans' },
  { id: 'AJLEPLIP', defaultScale: 1.65, name: 'Female 3', description: 'Asian woman, adult, dark hair, long shirt, blue pants' },
  { id: 'NQNCPALI', name: 'Male 3', description: 'Asian businessman, adult, dark hair, grey suit' },
  { id: 'KCWELCUL', defaultScale: 1.9, name: 'Male 4', description: 'Tall black man, basketball player, red tank top, blue shorts' },
  { id: 'NPZXOCME', defaultScale: 1.8, name: 'Male 5', description: 'Businessman, dark skin, tall, suit, tie' },
  { id: 'WLLXAURW', name: 'Alien 1', description: 'Alien, skinny, white skin' },
  { id: 'FIFWUVVB', name: 'Alien 2', description: 'Alien female, skinny, white skin, white shirt, black shorts' },
  { id: 'QCZVYPVJ', defaultScale: 1.9, name: 'Warrior', description: 'Warrior, RPG, male, warrior costume' },
  { id: 'KLWBCFFP', name: 'Monk', description: 'Chinese monk, bald, red robe' },
  { id: 'UTCDFTNO', defaultScale: 1.7, name: 'Banana man', description: 'Banana man, banana with arms and legs wearing shorts' },
  { id: 'QCHHFEYR', name: 'Beach man', description: 'Athletic shirtless man, dark hair, red swimming trunks, white skin' },
  { id: 'BEFGVCVZ', name: 'Bikini girl', description: 'White girl in beach gear, bikini top and white shorts, red hair' }
];

export function getNPCDescriptionByName(npcTypeName: string | null | undefined) {
  if (!npcTypeName) return null;
  return PREGENERATED_NPC_DESCRIPTIONS.find(d => d.name === npcTypeName) || null;
}

export function getNpcUrlByName(npcTypeName: string | null | undefined) {
  const desc = getNPCDescriptionByName(npcTypeName);
  if (!desc) return null;
  return `https://storage.googleapis.com/forged-assets/${desc.id}/output.glb`;
}

export function getNpcTypes() {
  return PREGENERATED_NPC_DESCRIPTIONS.map(d => d.name);
}


