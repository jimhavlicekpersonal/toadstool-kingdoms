import { TILE_H, TILE_W } from '../iso';
import { plate, type PainterDef } from './buildings';
import {
  acorn,
  blob,
  cylinder,
  darken,
  ellipsePath,
  face,
  gloss,
  lighten,
  rgba,
  rim,
  roundRectPath,
  shade,
  shadeRound,
  softDiamondPath,
  softShadow,
  type Ctx,
} from './toolkit';

const WOOD = '#c98450';
const STONE = '#c7c4dc';

function pinecone(ctx: Ctx, x: number, y: number, s: number): void {
  blob(ctx, { x: x - 7 * s, y: y - 10 * s, w: 14 * s, h: 20 * s }, '#b8763f', () => ctx.ellipse(x, y, 7 * s, 10 * s, 0, 0, Math.PI * 2), { line: 1.2 * s });
  ctx.strokeStyle = darken('#b8763f', 0.4);
  ctx.lineWidth = 1.1 * s;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(x - 6.5 * s, y + i * 3.5 * s - 2 * s);
    ctx.quadraticCurveTo(x, y + i * 3.5 * s + 2 * s, x + 6.5 * s, y + i * 3.5 * s - 2 * s);
    ctx.stroke();
  }
  gloss(ctx, x - 2.5 * s, y - 4 * s, 2 * s, 3.5 * s, 0.2, 0.55);
}

// ---------------------------------------------------------------- Burrow Barracks
const burrowBarracks: PainterDef = {
  extra: 100,
  paint(ctx, size) {
    plate(ctx, size, '#e8c48c');
    softShadow(ctx, 72, 30, 8, 0.3);
    // Grassy mound
    const mound = () => {
      ctx.moveTo(-70, 14);
      ctx.bezierCurveTo(-74, -64, 74, -64, 70, 14);
      ctx.bezierCurveTo(40, 26, -40, 26, -70, 14);
      ctx.closePath();
    };
    blob(ctx, { x: -70, y: -50, w: 140, h: 70 }, '#6fcf52', mound, { light: 0.35, line: 1.8 });
    ctx.fillStyle = rgba('#ffffff', 0.25);
    for (const [x, y] of [[-40, -20], [-10, -38], [26, -30], [46, -6]]) {
      ctx.beginPath();
      ctx.moveTo(x - 4, y);
      ctx.quadraticCurveTo(x, y - 8, x + 4, y);
      ctx.fill();
    }
    // Round door with a frame
    blob(ctx, { x: -26, y: -32, w: 52, h: 50 }, '#a86d3e', () => {
      ctx.moveTo(-26, 16);
      ctx.lineTo(-26, -6);
      ctx.arc(0, -6, 26, Math.PI, 0);
      ctx.lineTo(26, 16);
      ctx.quadraticCurveTo(0, 22, -26, 16);
      ctx.closePath();
    }, { line: 1.8 });
    blob(ctx, { x: -20, y: -26, w: 40, h: 42 }, '#d68d4f', () => {
      ctx.moveTo(-20, 16);
      ctx.lineTo(-20, -6);
      ctx.arc(0, -6, 20, Math.PI, 0);
      ctx.lineTo(20, 16);
      ctx.closePath();
    }, { line: 1.4 });
    ctx.strokeStyle = rgba('#7a4a22', 0.45);
    ctx.lineWidth = 1.5;
    for (const x of [-10, 0, 10]) {
      ctx.beginPath();
      ctx.moveTo(x, -24);
      ctx.lineTo(x, 16);
      ctx.stroke();
    }
    blob(ctx, { x: 10, y: -2, w: 6, h: 6 }, '#ffd34d', () => ellipsePath(ctx, 13, 1, 3, 3), { line: 1 });
    // Flag pole with a pennant
    ctx.beginPath();
    ctx.moveTo(38, -36);
    ctx.lineTo(38, -96);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#8a5a30';
    ctx.stroke();
    blob(ctx, { x: 38, y: -96, w: 30, h: 20 }, '#ff6b5b', () => {
      ctx.moveTo(39, -96);
      ctx.quadraticCurveTo(54, -92, 68, -88);
      ctx.quadraticCurveTo(54, -84, 39, -78);
      ctx.closePath();
    }, { line: 1.4 });
    blob(ctx, { x: 35, y: -102, w: 7, h: 7 }, '#ffd34d', () => ellipsePath(ctx, 38, -98, 3.5, 3.5), { line: 1 });
    // Training dummy
    blob(ctx, { x: -60, y: -20, w: 18, h: 30 }, '#f0d39d', () => roundRectPath(ctx, -60, -16, 16, 26, 7), { line: 1.4 });
    blob(ctx, { x: -60, y: -32, w: 16, h: 16 }, '#f0d39d', () => ellipsePath(ctx, -52, -24, 8, 8), { line: 1.4 });
    ctx.beginPath();
    ctx.moveTo(-64, -10);
    ctx.lineTo(-40, -10);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#a86d3e';
    ctx.stroke();
  },
};

// ---------------------------------------------------------------- Army Camp
const armyCamp: PainterDef = {
  extra: 70,
  paint(ctx, size) {
    plate(ctx, size, '#d9ef9f');
    // Log ring
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const x = Math.cos(a) * 52;
      const y = Math.sin(a) * 24;
      blob(ctx, { x: x - 11, y: y - 6, w: 22, h: 12 }, WOOD, () => ctx.ellipse(x, y, 11, 6, a + Math.PI / 2, 0, Math.PI * 2), { line: 1.2 });
    }
    // Tent at the back
    blob(ctx, { x: -60, y: -60, w: 50, h: 54 }, '#ffcf52', () => {
      ctx.moveTo(-58, -14);
      ctx.lineTo(-34, -60);
      ctx.lineTo(-10, -14);
      ctx.quadraticCurveTo(-34, -8, -58, -14);
      ctx.closePath();
    }, { line: 1.6 });
    ctx.beginPath();
    ctx.moveTo(-34, -60);
    ctx.lineTo(-34, -14);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = darken('#ffcf52', 0.4);
    ctx.stroke();
    blob(ctx, { x: 18, y: -56, w: 44, h: 46 }, '#8fd3ff', () => {
      ctx.moveTo(20, -14);
      ctx.lineTo(40, -56);
      ctx.lineTo(60, -14);
      ctx.quadraticCurveTo(40, -9, 20, -14);
      ctx.closePath();
    }, { line: 1.6 });
    // Campfire
    softShadow(ctx, 22, 10, 6, 0.25);
    for (const a of [0.4, -0.4, 1.4]) blob(ctx, { x: -14, y: -4, w: 28, h: 8 }, '#8f5a2e', () => ctx.ellipse(0, 2, 14, 4, a, 0, Math.PI * 2), { line: 1 });
    const flame = (s: number, c: string) => {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-12 * s, -6 * s, -6 * s, -18 * s, 0, -30 * s);
      ctx.bezierCurveTo(6 * s, -18 * s, 12 * s, -6 * s, 0, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, -30 * s, 0, 0);
      g.addColorStop(0, lighten(c, 0.4));
      g.addColorStop(1, c);
      ctx.fillStyle = g;
      ctx.fill();
    };
    flame(1.15, '#ff7a3d');
    flame(0.75, '#ffc93d');
    flame(0.4, '#fff3b0');
  },
};

// ---------------------------------------------------------------- Acorn Cannon
const acornCannon: PainterDef = {
  extra: 70,
  paint(ctx, size) {
    plate(ctx, size, '#d8dcef');
    softShadow(ctx, 62, 26, 6, 0.3);
    cylinder(ctx, 46, 20, 6, -10, STONE, '#dedbf0');
    // Wooden wheels
    for (const x of [-28, 28]) {
      blob(ctx, { x: x - 13, y: -40, w: 26, h: 26 }, WOOD, () => ellipsePath(ctx, x, -27, 12, 13), { line: 1.6 });
      blob(ctx, { x: x - 4, y: -31, w: 8, h: 8 }, '#ffcf52', () => ellipsePath(ctx, x, -27, 4, 4), { line: 1 });
    }
    // Barrel aimed down-left toward the attackers
    ctx.save();
    ctx.translate(-2, -36);
    ctx.rotate(0.38);
    const barrel = () => roundRectPath(ctx, -46, -14, 64, 28, 13);
    ctx.beginPath();
    barrel();
    const bg = ctx.createLinearGradient(0, -14, 0, 14);
    bg.addColorStop(0, '#a8b0c8');
    bg.addColorStop(0.3, '#e6eaf6');
    bg.addColorStop(1, '#6f7899');
    ctx.fillStyle = bg;
    ctx.fill();
    rim(ctx, '#8a92b0', 1.8);
    for (const x of [-30, 4]) {
      ctx.beginPath();
      ctx.rect(x, -14, 6, 28);
      ctx.fillStyle = '#ffcf52';
      ctx.fill();
      rim(ctx, '#ffcf52', 1);
    }
    blob(ctx, { x: -52, y: -15, w: 14, h: 30 }, '#6f7899', () => ctx.ellipse(-46, 0, 7, 15, 0, 0, Math.PI * 2), { line: 1.4 });
    ctx.beginPath();
    ctx.ellipse(-46, 0, 4, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#2b1838';
    ctx.fill();
    ctx.restore();
    acorn(ctx, 26, -58, 0.9);
    face(ctx, 0, -2, 0.9, { mood: 'determined' });
  },
};

// ---------------------------------------------------------------- Pinecone Catapult
const pineconeCatapult: PainterDef = {
  extra: 90,
  paint(ctx, size) {
    plate(ctx, size, '#e8c48c');
    softShadow(ctx, 62, 26, 6, 0.3);
    // Base frame
    blob(ctx, { x: -50, y: -16, w: 100, h: 30 }, WOOD, () => roundRectPath(ctx, -50, -14, 100, 26, 10), { line: 1.8 });
    for (const x of [-38, 38]) blob(ctx, { x: x - 10, y: -2, w: 20, h: 20 }, '#a86d3e', () => ellipsePath(ctx, x, 10, 10, 10), { line: 1.4 });
    // Uprights and axle
    for (const x of [-24, 24]) blob(ctx, { x: x - 5, y: -64, w: 10, h: 54 }, '#d99a58', () => roundRectPath(ctx, x - 5, -64, 10, 54, 4), { line: 1.4 });
    blob(ctx, { x: -30, y: -62, w: 60, h: 10 }, '#a86d3e', () => roundRectPath(ctx, -30, -62, 60, 9, 4), { line: 1.4 });
    // Throwing arm cocked back with a pinecone in the cup
    ctx.save();
    ctx.translate(0, -56);
    ctx.rotate(-0.9);
    blob(ctx, { x: -6, y: -70, w: 12, h: 76 }, '#e2a764', () => roundRectPath(ctx, -5, -70, 10, 76, 5), { line: 1.4 });
    blob(ctx, { x: -14, y: -84, w: 28, h: 18 }, '#a86d3e', () => {
      ctx.moveTo(-14, -78);
      ctx.quadraticCurveTo(0, -60, 14, -78);
      ctx.closePath();
    }, { line: 1.4 });
    pinecone(ctx, 0, -84, 1.1);
    ctx.restore();
    face(ctx, 0, -2, 0.75, { mood: 'determined' });
  },
};

// ---------------------------------------------------------------- Wasp Nest
const waspNest: PainterDef = {
  extra: 100,
  paint(ctx, size) {
    plate(ctx, size, '#e8c48c');
    softShadow(ctx, 40, 18, 6, 0.3);
    blob(ctx, { x: -5, y: -80, w: 10, h: 86 }, WOOD, () => roundRectPath(ctx, -5, -80, 10, 86, 4), { line: 1.4 });
    blob(ctx, { x: -26, y: -84, w: 52, h: 10 }, '#a86d3e', () => roundRectPath(ctx, -26, -84, 52, 8, 4), { line: 1.4 });
    // Papery hive
    const hive = () => {
      ctx.moveTo(0, -78);
      ctx.bezierCurveTo(34, -78, 36, -24, 0, -18);
      ctx.bezierCurveTo(-36, -24, -34, -78, 0, -78);
      ctx.closePath();
    };
    blob(ctx, { x: -34, y: -78, w: 68, h: 60 }, '#f6d27a', hive, { line: 1.8 });
    ctx.strokeStyle = rgba('#b07c24', 0.5);
    ctx.lineWidth = 2;
    for (const y of [-66, -54, -42, -30]) {
      const w = 30 - Math.abs(y + 48) * 0.5;
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.quadraticCurveTo(0, y + 5, w, y);
      ctx.stroke();
    }
    blob(ctx, { x: -6, y: -36, w: 12, h: 10 }, '#4a2a1a', () => ellipsePath(ctx, 0, -31, 6, 5), { line: 1 });
    gloss(ctx, -14, -62, 6, 10, 0.3, 0.5);
    // A friendly-but-fierce wasp
    const wasp = (x: number, y: number) => {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.ellipse(x - 3, y - 6, 5, 3, -0.6, 0, Math.PI * 2);
      ctx.ellipse(x + 3, y - 6, 5, 3, 0.6, 0, Math.PI * 2);
      ctx.fill();
      blob(ctx, { x: x - 7, y: y - 4, w: 14, h: 9 }, '#ffcf3d', () => ctx.ellipse(x, y, 7, 4.5, 0, 0, Math.PI * 2), { line: 1 });
      ctx.fillStyle = '#3a2350';
      for (const dx of [-1.5, 2.5]) ctx.fillRect(x + dx, y - 4, 1.6, 8);
      ctx.beginPath();
      ctx.arc(x - 6, y - 1, 1, 0, Math.PI * 2);
      ctx.fill();
    };
    wasp(26, -70);
    wasp(-28, -46);
    face(ctx, 0, -48, 0.85, { mood: 'determined' });
  },
};

// ---------------------------------------------------------------- Firefly Tower
const fireflyTower: PainterDef = {
  extra: 120,
  paint(ctx, size) {
    plate(ctx, size, '#d8dcef');
    softShadow(ctx, 40, 18, 6, 0.3);
    cylinder(ctx, 22, 10, 4, -64, STONE, '#dedbf0');
    ctx.strokeStyle = rgba('#7a7598', 0.35);
    ctx.lineWidth = 1.3;
    for (const y of [-14, -34, -54]) {
      ctx.beginPath();
      ctx.ellipse(0, y, 22, 10, 0, 0.1, Math.PI - 0.1);
      ctx.stroke();
    }
    // Lantern cage with a glowing swarm
    const glow = ctx.createRadialGradient(0, -92, 2, 0, -92, 40);
    glow.addColorStop(0, 'rgba(255,250,170,0.9)');
    glow.addColorStop(1, 'rgba(255,240,120,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -92, 40, 0, Math.PI * 2);
    ctx.fill();
    blob(ctx, { x: -18, y: -114, w: 36, h: 46 }, '#fff3b0', () => roundRectPath(ctx, -17, -112, 34, 44, 14), { light: 0.5, line: 1.6 });
    ctx.strokeStyle = '#8a6a3a';
    ctx.lineWidth = 2;
    for (const x of [-8, 0, 8]) {
      ctx.beginPath();
      ctx.moveTo(x, -112);
      ctx.lineTo(x, -68);
      ctx.stroke();
    }
    blob(ctx, { x: -22, y: -124, w: 44, h: 14 }, '#7b5fd1', () => {
      ctx.moveTo(-22, -112);
      ctx.quadraticCurveTo(0, -132, 22, -112);
      ctx.closePath();
    }, { line: 1.4 });
    for (const [x, y] of [[-6, -98], [6, -86], [-2, -78], [5, -102]]) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fffbe0';
      ctx.fill();
    }
    face(ctx, 0, -34, 0.8);
  },
};

// ---------------------------------------------------------------- Bramble Hedge
const brambleHedge: PainterDef = {
  extra: 22,
  paint(ctx) {
    softShadow(ctx, 26, 11, 4, 0.25);
    const puffs: [number, number, number][] = [[-12, -6, 11], [12, -6, 11], [0, -14, 13], [0, 0, 12]];
    for (const [x, y, r] of puffs) blob(ctx, { x: x - r, y: y - r, w: r * 2, h: r * 2 }, '#4fae45', () => ellipsePath(ctx, x, y, r, r * 0.85), { light: 0.35, line: 1.3 });
    ctx.fillStyle = '#e8f5c8';
    for (const [x, y] of [[-16, -12], [14, -14], [-4, -24], [6, 2], [-10, 4], [18, -2]]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x + 1.6, y + 1);
      ctx.lineTo(x - 1.6, y + 1);
      ctx.closePath();
      ctx.fill();
    }
    for (const [x, y] of [[-6, -10], [8, -4], [2, -18]]) blob(ctx, { x: x - 3, y: y - 3, w: 6, h: 6 }, '#ff5a7a', () => ellipsePath(ctx, x, y, 2.8, 2.8), { line: 0.8 });
    gloss(ctx, -6, -18, 6, 3, -0.4, 0.4);
  },
};

// ---------------------------------------------------------------- Traps (only the owner sees them)
const thornSnare: PainterDef = {
  extra: 14,
  paint(ctx) {
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120, 80, 50, 0.3)';
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = Math.cos(a) * 14;
      const y = Math.sin(a) * 7;
      blob(ctx, { x: x - 3, y: y - 10, w: 6, h: 11 }, '#6fae45', () => {
        ctx.moveTo(x - 3, y);
        ctx.lineTo(x, y - 10);
        ctx.lineTo(x + 3, y);
        ctx.closePath();
      }, { line: 0.9 });
    }
    blob(ctx, { x: -6, y: -6, w: 12, h: 8 }, '#8a5a30', () => ellipsePath(ctx, 0, -2, 6, 4), { line: 0.9 });
  },
};

const sapPuddle: PainterDef = {
  extra: 8,
  paint(ctx) {
    blob(ctx, { x: -22, y: -10, w: 44, h: 20 }, '#f0a63c', () => {
      ctx.moveTo(-20, 0);
      ctx.bezierCurveTo(-22, -10, -4, -12, 4, -8);
      ctx.bezierCurveTo(16, -12, 24, -2, 18, 4);
      ctx.bezierCurveTo(12, 11, -14, 11, -20, 0);
      ctx.closePath();
    }, { light: 0.45, line: 1.2 });
    gloss(ctx, -6, -3, 7, 2.5, 0, 0.8);
    gloss(ctx, 9, 2, 3, 1.2, 0, 0.7);
  },
};

// ---------------------------------------------------------------- Grove Lodge
const groveLodge: PainterDef = {
  extra: 110,
  paint(ctx, size) {
    plate(ctx, size, '#e8c48c');
    softShadow(ctx, 70, 28, 8, 0.3);
    // Log walls
    blob(ctx, { x: -56, y: -60, w: 112, h: 74 }, '#c98450', () => roundRectPath(ctx, -56, -58, 112, 70, 14), { line: 1.8 });
    ctx.strokeStyle = rgba('#7a4a22', 0.35);
    ctx.lineWidth = 2;
    for (const y of [-40, -22, -4]) {
      ctx.beginPath();
      ctx.moveTo(-54, y);
      ctx.lineTo(54, y);
      ctx.stroke();
    }
    // Leafy roof
    const roof = () => {
      ctx.moveTo(-72, -50);
      ctx.quadraticCurveTo(-40, -112, 0, -122);
      ctx.quadraticCurveTo(40, -112, 72, -50);
      ctx.quadraticCurveTo(0, -38, -72, -50);
      ctx.closePath();
    };
    blob(ctx, { x: -72, y: -122, w: 144, h: 84 }, '#5fc84a', roof, { light: 0.4, line: 1.8 });
    for (const [x, y] of [[-40, -70], [0, -96], [36, -72], [-16, -60], [20, -54]]) gloss(ctx, x, y, 12, 5, -0.3, 0.35);
    // Round door and windows
    blob(ctx, { x: -16, y: -28, w: 32, h: 40 }, '#8f5a2e', () => {
      ctx.moveTo(-16, 12);
      ctx.lineTo(-16, -10);
      ctx.arc(0, -10, 16, Math.PI, 0);
      ctx.lineTo(16, 12);
      ctx.closePath();
    }, { line: 1.4 });
    for (const x of [-38, 38]) {
      ctx.beginPath();
      ellipsePath(ctx, x, -26, 8, 8);
      ctx.fillStyle = '#ffe58a';
      ctx.fill();
      rim(ctx, '#c98450', 1.6);
    }
    // Banner with a leaf
    ctx.beginPath();
    ctx.moveTo(48, -98);
    ctx.lineTo(48, -150);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#8a5a30';
    ctx.stroke();
    blob(ctx, { x: 48, y: -150, w: 26, h: 34 }, '#47b9f5', () => {
      ctx.moveTo(49, -150);
      ctx.lineTo(74, -150);
      ctx.lineTo(74, -118);
      ctx.lineTo(61, -126);
      ctx.lineTo(49, -118);
      ctx.closePath();
    }, { line: 1.3 });
    blob(ctx, { x: 55, y: -146, w: 14, h: 14 }, '#7fd85a', () => ctx.ellipse(62, -139, 6, 4, -0.6, 0, Math.PI * 2), { line: 1 });
    face(ctx, 0, -78, 0.9);
  },
};

// ---------------------------------------------------------------- Guardian Burrow
const guardianBurrow: PainterDef = {
  extra: 70,
  paint(ctx, size) {
    plate(ctx, size, '#cfe3a8');
    softShadow(ctx, 58, 24, 6, 0.3);
    // Grassy mound
    blob(ctx, { x: -56, y: -62, w: 112, h: 74 }, '#7fc65a', () => {
      ctx.moveTo(-56, 6);
      ctx.bezierCurveTo(-54, -52, 54, -52, 56, 6);
      ctx.quadraticCurveTo(0, 18, -56, 6);
      ctx.closePath();
    }, { light: 0.35, line: 1.6 });
    // Burrow mouth with a little wooden arch
    blob(ctx, { x: -24, y: -34, w: 48, h: 38 }, '#3a2350', () => {
      ctx.moveTo(-22, 4);
      ctx.bezierCurveTo(-22, -34, 22, -34, 22, 4);
      ctx.closePath();
    }, { line: 1.2 });
    ctx.beginPath();
    ctx.moveTo(-26, 4);
    ctx.bezierCurveTo(-26, -40, 26, -40, 26, 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = WOOD;
    ctx.stroke();
    // Two eyes peeking out of the dark
    for (const x of [-7, 7]) {
      ctx.beginPath();
      ellipsePath(ctx, x, -12, 3, 3.4);
      ctx.fillStyle = '#fff6c8';
      ctx.fill();
    }
    // Banner on a pole
    ctx.beginPath();
    ctx.moveTo(34, -20);
    ctx.lineTo(34, -78);
    ctx.lineWidth = 3;
    ctx.strokeStyle = WOOD;
    ctx.stroke();
    blob(ctx, { x: 34, y: -78, w: 26, h: 20 }, '#ff6b5b', () => {
      ctx.moveTo(35, -78);
      ctx.lineTo(60, -72);
      ctx.lineTo(35, -60);
      ctx.closePath();
    }, { line: 1.2 });
    blob(ctx, { x: -48, y: -30, w: 14, h: 12 }, '#ffd23f', () => ellipsePath(ctx, -41, -24, 6, 5), { line: 1 });
  },
};

export const militaryPainters: Record<string, PainterDef> = {
  guardian_burrow: guardianBurrow,
  grove_lodge: groveLodge,
  thorn_snare: thornSnare,
  sap_puddle: sapPuddle,
  burrow_barracks: burrowBarracks,
  army_camp: armyCamp,
  acorn_cannon: acornCannon,
  pinecone_catapult: pineconeCatapult,
  wasp_nest: waspNest,
  firefly_tower: fireflyTower,
  bramble_hedge: brambleHedge,
};

/** Rubble left where a building was destroyed. */
export function paintRubble(ctx: Ctx, size: number): void {
  const hw = (size * TILE_W) / 2 - 6;
  const hh = (size * TILE_H) / 2 - 3;
  ctx.beginPath();
  softDiamondPath(ctx, hw, hh);
  ctx.fillStyle = 'rgba(120, 90, 70, 0.35)';
  ctx.fill();
  const n = 4 + size * 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i;
    const r = (i % 3) * 0.25 + 0.2;
    const x = Math.cos(a) * hw * r;
    const y = Math.sin(a) * hh * r - 2;
    const c = i % 2 ? '#b5a59a' : '#c98a54';
    blob(ctx, { x: x - 7, y: y - 5, w: 14, h: 10 }, c, () => roundRectPath(ctx, x - 6, y - 4, 12, 8, 3), { line: 1 });
  }
  ctx.fillStyle = 'rgba(80,60,60,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, hw * 0.4, hh * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------- Troops

export interface TroopArt {
  w: number;
  h: number;
  paint: (ctx: Ctx) => void;
}

export const troopArt: Record<string, TroopArt> = {
  hedgehog_roller: {
    w: 40,
    h: 36,
    paint(ctx) {
      softShadow(ctx, 14, 5, 0, 0.3);
      // Spikes
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI + (i / 12) * Math.PI;
        const r = i % 2 ? 13 : 18;
        const x = Math.cos(a) * r - 2;
        const y = Math.sin(a) * r * 0.95 - 12;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(10, -4);
      ctx.lineTo(-14, -4);
      ctx.closePath();
      shade(ctx, { x: -20, y: -30, w: 36, h: 28 }, '#8b5a34', 0.3, 0.25);
      rim(ctx, '#8b5a34', 1.3);
      blob(ctx, { x: -6, y: -18, w: 20, h: 18 }, '#f6d9b0', () => ctx.ellipse(5, -9, 9, 8, 0, 0, Math.PI * 2), { line: 1.2 });
      blob(ctx, { x: 11, y: -12, w: 6, h: 5 }, '#3a2350', () => ellipsePath(ctx, 14, -9.5, 2.5, 2.2), { line: 0.8 });
      face(ctx, 5, -11, 0.45, { blush: true });
      for (const x of [-6, 6]) blob(ctx, { x: x - 3, y: -4, w: 6, h: 4 }, '#f6d9b0', () => ellipsePath(ctx, x, -2, 3, 2), { line: 0.8 });
    },
  },
  frog_lobber: {
    w: 40,
    h: 38,
    paint(ctx) {
      softShadow(ctx, 14, 5, 0, 0.3);
      blob(ctx, { x: -14, y: -24, w: 28, h: 24 }, '#5fcf4a', () => ctx.ellipse(0, -11, 14, 11, 0, 0, Math.PI * 2), { light: 0.4, line: 1.3 });
      blob(ctx, { x: -9, y: -14, w: 18, h: 12 }, '#d9f7b0', () => ctx.ellipse(0, -6, 9, 5.5, 0, 0, Math.PI * 2), { line: 0.9 });
      for (const x of [-7, 7]) {
        blob(ctx, { x: x - 6, y: -30, w: 12, h: 12 }, '#5fcf4a', () => ellipsePath(ctx, x, -23, 6, 6), { line: 1.1 });
        ctx.beginPath();
        ellipsePath(ctx, x, -23, 4, 4);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ellipsePath(ctx, x + 0.6, -22.5, 2.3, 2.6);
        ctx.fillStyle = '#2b1838';
        ctx.fill();
        ctx.beginPath();
        ellipsePath(ctx, x + 1.2, -23.6, 0.9, 0.9);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, -13, 4, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#2b1838';
      ctx.stroke();
      // Satchel of pebbles
      blob(ctx, { x: 8, y: -14, w: 12, h: 11 }, '#c98450', () => roundRectPath(ctx, 8, -13, 11, 10, 3), { line: 1 });
      for (const x of [10, 14, 17]) blob(ctx, { x: x - 2, y: -16, w: 4, h: 4 }, '#b9b4cf', () => ellipsePath(ctx, x, -14, 2, 2), { line: 0.6 });
    },
  },
  beetle_brute: {
    w: 60,
    h: 52,
    paint(ctx) {
      softShadow(ctx, 22, 7, 0, 0.32);
      ctx.strokeStyle = '#3a2350';
      ctx.lineWidth = 2;
      for (const [x1, x2] of [[-14, -22], [0, -2], [14, 22]]) {
        ctx.beginPath();
        ctx.moveTo(x1, -8);
        ctx.lineTo(x2, 0);
        ctx.stroke();
      }
      blob(ctx, { x: -22, y: -40, w: 44, h: 34 }, '#7b5fd1', () => ctx.ellipse(0, -21, 22, 17, 0, 0, Math.PI * 2), { light: 0.45, dark: 0.3, line: 1.6 });
      ctx.beginPath();
      ctx.moveTo(0, -38);
      ctx.lineTo(0, -6);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = darken('#7b5fd1', 0.45);
      ctx.stroke();
      gloss(ctx, -9, -30, 8, 5, -0.5, 0.75);
      blob(ctx, { x: 10, y: -30, w: 20, h: 18 }, '#4a3580', () => ctx.ellipse(19, -20, 10, 9, 0, 0, Math.PI * 2), { line: 1.3 });
      blob(ctx, { x: 22, y: -44, w: 10, h: 20 }, '#ffcf52', () => {
        ctx.moveTo(24, -26);
        ctx.quadraticCurveTo(30, -36, 27, -46);
        ctx.quadraticCurveTo(34, -38, 30, -24);
        ctx.closePath();
      }, { line: 1 });
      face(ctx, 19, -21, 0.45, { mood: 'determined', blush: false });
    },
  },
  owl_bomber: {
    w: 58,
    h: 60,
    paint(ctx) {
      // Drawn flying: the shadow is drawn separately on the ground by the scene.
      for (const d of [-1, 1]) {
        blob(ctx, { x: d < 0 ? -30 : 8, y: -44, w: 22, h: 18 }, '#c9925a', () => ctx.ellipse(d * 19, -34, 12, 7, d * -0.5, 0, Math.PI * 2), { line: 1.2 });
      }
      blob(ctx, { x: -15, y: -54, w: 30, h: 34 }, '#d9a46a', () => ctx.ellipse(0, -37, 15, 17, 0, 0, Math.PI * 2), { light: 0.4, line: 1.4 });
      blob(ctx, { x: -9, y: -40, w: 18, h: 18 }, '#fbe7c6', () => ctx.ellipse(0, -30, 9, 9, 0, 0, Math.PI * 2), { line: 0.9 });
      for (const x of [-6, 6]) {
        ctx.beginPath();
        ellipsePath(ctx, x, -43, 5.5, 5.5);
        ctx.fillStyle = '#fff6e0';
        ctx.fill();
        rim(ctx, '#d9a46a', 1);
      }
      face(ctx, 0, -43, 0.9, { blush: false });
      blob(ctx, { x: -2, y: -40, w: 4, h: 5 }, '#ffb340', () => {
        ctx.moveTo(-2, -39);
        ctx.lineTo(2, -39);
        ctx.lineTo(0, -35);
        ctx.closePath();
      }, { line: 0.7 });
      for (const x of [-7, 7]) {
        ctx.beginPath();
        ctx.moveTo(x - 3, -58);
        ctx.lineTo(x, -52);
        ctx.lineTo(x + 3, -58);
        ctx.fillStyle = '#c9925a';
        ctx.fill();
      }
      // Seed bomb in its talons
      blob(ctx, { x: -7, y: -20, w: 14, h: 14 }, '#7a5a3a', () => ellipsePath(ctx, 0, -13, 7, 7), { line: 1.1 });
      ctx.beginPath();
      ctx.moveTo(0, -20);
      ctx.quadraticCurveTo(3, -24, 6, -23);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#6fcf52';
      ctx.stroke();
    },
  },
  mole_digger: {
    w: 44,
    h: 40,
    paint(ctx) {
      softShadow(ctx, 15, 5, 0, 0.3);
      blob(ctx, { x: -14, y: -26, w: 28, h: 26 }, '#7a6a8f', () => ctx.ellipse(0, -12, 14, 13, 0, 0, Math.PI * 2), { light: 0.35, line: 1.3 });
      blob(ctx, { x: -9, y: -14, w: 18, h: 12 }, '#c8b8d8', () => ctx.ellipse(0, -7, 9, 6, 0, 0, Math.PI * 2), { line: 0.8 });
      blob(ctx, { x: -4, y: -18, w: 8, h: 6 }, '#ff8fb0', () => ellipsePath(ctx, 0, -15, 4, 3), { line: 0.8 });
      face(ctx, 0, -18, 0.42, { blush: true });
      for (const x of [-13, 13]) blob(ctx, { x: x - 5, y: -10, w: 10, h: 7 }, '#ffc0d0', () => ellipsePath(ctx, x, -7, 5, 3.5), { line: 0.8 });
      // Hard hat with a lamp
      blob(ctx, { x: -13, y: -34, w: 26, h: 14 }, '#ffcf3d', () => {
        ctx.moveTo(-13, -22);
        ctx.bezierCurveTo(-13, -36, 13, -36, 13, -22);
        ctx.closePath();
      }, { line: 1.2 });
      blob(ctx, { x: -4, y: -34, w: 8, h: 7 }, '#fffbe0', () => ellipsePath(ctx, 0, -30, 3.5, 3), { line: 0.8 });
      // Shovel
      ctx.beginPath();
      ctx.moveTo(14, -6);
      ctx.lineTo(22, -30);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = WOOD;
      ctx.stroke();
      blob(ctx, { x: 18, y: -40, w: 10, h: 12 }, '#b9b4cf', () => {
        ctx.moveTo(19, -30);
        ctx.quadraticCurveTo(20, -40, 25, -39);
        ctx.quadraticCurveTo(28, -34, 25, -29);
        ctx.closePath();
      }, { line: 1 });
    },
  },
};

// ---------------------------------------------------------------- Guardian animals (defend opponent bases)

troopArt.badger_warden = {
  w: 50,
  h: 42,
  paint(ctx) {
    softShadow(ctx, 18, 6, 0, 0.32);
    blob(ctx, { x: -20, y: -30, w: 40, h: 30 }, '#6d6a80', () => ctx.ellipse(0, -14, 20, 15, 0, 0, Math.PI * 2), { light: 0.35, dark: 0.3, line: 1.5 });
    // White stripe and face
    blob(ctx, { x: 4, y: -30, w: 22, h: 22 }, '#f4f1ff', () => ctx.ellipse(15, -19, 11, 10, 0, 0, Math.PI * 2), { line: 1.2 });
    blob(ctx, { x: 9, y: -30, w: 12, h: 18 }, '#3a3550', () => roundRectPath(ctx, 12, -30, 6, 16, 3), { line: 0.6 });
    blob(ctx, { x: 22, y: -18, w: 6, h: 5 }, '#3a2350', () => ellipsePath(ctx, 25, -15, 2.6, 2.2), { line: 0.6 });
    face(ctx, 15, -16, 0.42, { mood: 'determined', blush: false });
    // Little guard helmet
    blob(ctx, { x: 5, y: -38, w: 20, h: 10 }, '#ffcf52', () => {
      ctx.moveTo(5, -30);
      ctx.bezierCurveTo(5, -40, 25, -40, 25, -30);
      ctx.closePath();
    }, { line: 1 });
    for (const x of [-12, 4]) blob(ctx, { x: x - 4, y: -5, w: 8, h: 6 }, '#4f4b63', () => ellipsePath(ctx, x, -2, 4, 3), { line: 0.8 });
  },
};

troopArt.stoat_skirmisher = {
  w: 44,
  h: 34,
  paint(ctx) {
    softShadow(ctx, 15, 5, 0, 0.3);
    // Long body and black-tipped tail
    blob(ctx, { x: -20, y: -18, w: 32, h: 14 }, '#d9884a', () => ctx.ellipse(-4, -11, 16, 7, -0.1, 0, Math.PI * 2), { light: 0.4, line: 1.2 });
    ctx.beginPath();
    ctx.moveTo(-18, -12);
    ctx.quadraticCurveTo(-28, -20, -24, -28);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#d9884a';
    ctx.stroke();
    blob(ctx, { x: -28, y: -32, w: 8, h: 8 }, '#2b1838', () => ellipsePath(ctx, -24, -28, 3.5, 3.5), { line: 0.6 });
    blob(ctx, { x: 4, y: -26, w: 18, h: 16 }, '#d9884a', () => ctx.ellipse(13, -18, 9, 8, 0, 0, Math.PI * 2), { line: 1.2 });
    blob(ctx, { x: 8, y: -20, w: 12, h: 9 }, '#fff3e0', () => ctx.ellipse(14, -15, 6, 4, 0, 0, Math.PI * 2), { line: 0.6 });
    for (const x of [8, 17]) blob(ctx, { x: x - 3, y: -30, w: 6, h: 6 }, '#d9884a', () => ellipsePath(ctx, x, -26, 2.8, 3), { line: 0.8 });
    face(ctx, 13, -19, 0.36, { mood: 'grin', blush: true });
  },
};

troopArt.hawk_sentinel = {
  w: 62,
  h: 56,
  paint(ctx) {
    // Drawn flying; the scene draws its shadow on the ground.
    for (const d of [-1, 1]) {
      blob(ctx, { x: d < 0 ? -32 : 6, y: -46, w: 26, h: 16 }, '#9a6a3e', () => {
        ctx.moveTo(d * 4, -36);
        ctx.quadraticCurveTo(d * 18, -50, d * 30, -40);
        ctx.quadraticCurveTo(d * 18, -36, d * 4, -30);
        ctx.closePath();
      }, { line: 1.2 });
    }
    blob(ctx, { x: -12, y: -50, w: 24, h: 30 }, '#b07a48', () => ctx.ellipse(0, -35, 12, 15, 0, 0, Math.PI * 2), { light: 0.4, line: 1.3 });
    blob(ctx, { x: -8, y: -38, w: 16, h: 16 }, '#f7e7cf', () => ctx.ellipse(0, -29, 8, 8, 0, 0, Math.PI * 2), { line: 0.8 });
    face(ctx, 0, -41, 0.5, { mood: 'determined', blush: false });
    blob(ctx, { x: -3, y: -40, w: 6, h: 6 }, '#ffb340', () => {
      ctx.moveTo(-3, -38);
      ctx.lineTo(3, -38);
      ctx.lineTo(0, -33);
      ctx.closePath();
    }, { line: 0.7 });
    // Red guard sash
    ctx.beginPath();
    ctx.moveTo(-10, -32);
    ctx.lineTo(10, -24);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff6b5b';
    ctx.stroke();
  },
};

// ---------------------------------------------------------------- Projectiles and effects

export const projectileArt: Record<string, { w: number; h: number; paint: (ctx: Ctx) => void }> = {
  acorn: { w: 18, h: 20, paint: (ctx) => acorn(ctx, 0, -2, 0.8) },
  pinecone: { w: 22, h: 28, paint: (ctx) => pinecone(ctx, 0, 0, 1) },
  pebble: { w: 10, h: 10, paint: (ctx) => blob(ctx, { x: -4, y: -4, w: 8, h: 8 }, '#b9b4cf', () => ellipsePath(ctx, 0, 0, 4, 3.5), { line: 0.8 }) },
  sting: {
    w: 14,
    h: 8,
    paint(ctx) {
      blob(ctx, { x: -6, y: -2, w: 12, h: 4 }, '#ffcf3d', () => {
        ctx.moveTo(-6, -2);
        ctx.lineTo(6, 0);
        ctx.lineTo(-6, 2);
        ctx.closePath();
      }, { line: 0.8 });
    },
  },
  spark: {
    w: 20,
    h: 20,
    paint(ctx) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 9);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.4, '#fff6a0');
      g.addColorStop(1, 'rgba(255,230,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  feather: {
    w: 16,
    h: 8,
    paint(ctx) {
      blob(ctx, { x: -7, y: -3, w: 14, h: 6 }, '#f7e7cf', () => ctx.ellipse(0, 0, 7, 2.6, 0.2, 0, Math.PI * 2), { line: 0.8 });
      ctx.beginPath();
      ctx.moveTo(-7, 0);
      ctx.lineTo(7, 0);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = '#9a6a3e';
      ctx.stroke();
    },
  },
  seedbomb: {
    w: 16,
    h: 18,
    paint(ctx) {
      blob(ctx, { x: -6, y: -4, w: 12, h: 12 }, '#7a5a3a', () => ellipsePath(ctx, 0, 2, 6, 6), { line: 1 });
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.quadraticCurveTo(3, -8, 5, -7);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#6fcf52';
      ctx.stroke();
    },
  },
};

export function paintPuff(ctx: Ctx): void {
  for (const [x, y, r] of [[-8, 2, 9], [8, 2, 9], [0, -5, 11], [0, 5, 9]] as const) {
    const g = ctx.createRadialGradient(x - 2, y - 3, 1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, 'rgba(235,230,255,0.85)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function paintStar(ctx: Ctx, color = '#ffd23f'): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const r = i % 2 ? 4.5 : 10;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  shade(ctx, { x: -10, y: -10, w: 20, h: 20 }, color, 0.5, 0.2);
  rim(ctx, color, 1.2);
}

export function paintShadowDisc(ctx: Ctx): void {
  softShadow(ctx, 16, 6, 0, 0.35);
}

export { shadeRound };
