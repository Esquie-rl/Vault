/* ─────────────────────────────────────────────────────────────────────────
   mp4method.js — « Upload Method » : patch de conteneur MP4, sans reencodage.

   Ce que fait la methode (retro-ingenierie de compressbase.com/upload-method,
   sortie comparee octet par octet a une entree connue) :

     1. FASTSTART — le `moov` passe devant le `mdat`. Le flux video et le flux
        audio sont recopies tels quels : aucun pixel, aucun echantillon audio
        n'est reencode. La sortie est bit-identique sur les donnees.
     2. EDIT LISTS SUPPRIMEES — les `edts`/`elst` sautent sur toutes les
        pistes. Les plateformes s'en servent pour decaler le debut ; sans
        elles, le premier echantillon est pris tel quel.
     3. PATCH FPS — on ajoute a la piste AUDIO N echantillons factices de
        8 octets, chacun d'une duree de 1 tick (1/timescale de seconde).
        Le compteur d'echantillons audio est ainsi multiplie par
        `fpsMultiplier` (10 par defaut, la valeur observee sur le site).
        Un sondeur naif qui deduit une cadence de `nb_samples / duree` lit
        alors une valeur dix fois plus haute — c'est tout le « FPS method ».

   Les en-tetes de duree (`mvhd`, `tkhd`, `mdhd`) ne bougent pas : la piste
   audio declare donc une table d'echantillons legerement plus longue que sa
   duree annoncee. C'est volontaire, et c'est exactement ce que produit le
   site d'origine.

   Aucune dependance : ni ffmpeg, ni WebAssembly, ni serveur. Le meme fichier
   tourne dans le navigateur (module ES) et sous Node (`require`).
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

/* Conteneurs dont on reconstruit les enfants. Tout le reste est recopie
   tel quel — notamment `udta`/`meta`, dont la structure interne varie et
   que la methode n'a aucune raison de toucher. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex']);

/* Charge utile d'un echantillon de bourrage : 8 octets qui se lisent comme
   un en-tete de boite de taille 4 suivi de zeros. Un parseur qui balaierait
   la queue du fichier en croyant y voir des boites avance sans se bloquer.
   C'est la valeur exacte ecrite par le site d'origine. */
const PAD_SAMPLE = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
const PAD_SIZE = PAD_SAMPLE.length;

const u32max = 0xffffffff;

/* ── lecture ────────────────────────────────────────────────────────────── */

function typeOf(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/* Decoupe [start,end) en boites. Les conteneurs connus sont explores ;
   les autres gardent leur charge utile brute. */
function parseBoxes(bytes, view, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = typeOf(bytes, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      const hi = view.getUint32(off + 8);
      const lo = view.getUint32(off + 12);
      size = hi * 0x100000000 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - off;           // « jusqu'a la fin du fichier »
    }
    if (size < header || off + size > end) break;   // boite tronquee : on s'arrete la
    const box = {
      type,
      fileStart: off,             // position d'origine, sert au remappage des offsets
      dataStart: off + header,
      dataEnd: off + size,
    };
    if (CONTAINERS.has(type)) {
      box.children = parseBoxes(bytes, view, box.dataStart, box.dataEnd);
    } else {
      box.payload = bytes.subarray(box.dataStart, box.dataEnd);
    }
    boxes.push(box);
    off += size;
  }
  return boxes;
}

function findChild(box, type) {
  return box.children ? box.children.find((c) => c.type === type) : undefined;
}

function findPath(box, path) {
  let cur = box;
  for (const type of path) {
    cur = findChild(cur, type);
    if (!cur) return undefined;
  }
  return cur;
}

/* ── tables d'echantillons ──────────────────────────────────────────────── */

function readTable(box) {
  const p = box.payload;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  switch (box.type) {
    case 'stts': {
      const n = dv.getUint32(4);
      const entries = [];
      for (let i = 0; i < n; i++) entries.push([dv.getUint32(8 + i * 8), dv.getUint32(12 + i * 8)]);
      return { version: p[0], entries };
    }
    case 'stsc': {
      const n = dv.getUint32(4);
      const entries = [];
      for (let i = 0; i < n; i++) {
        entries.push([dv.getUint32(8 + i * 12), dv.getUint32(12 + i * 12), dv.getUint32(16 + i * 12)]);
      }
      return { version: p[0], entries };
    }
    case 'stsz': {
      const constant = dv.getUint32(4);
      const count = dv.getUint32(8);
      const sizes = [];
      if (constant === 0) for (let i = 0; i < count; i++) sizes.push(dv.getUint32(12 + i * 4));
      else for (let i = 0; i < count; i++) sizes.push(constant);
      return { version: p[0], sizes };
    }
    case 'stco': {
      const n = dv.getUint32(4);
      const offsets = [];
      for (let i = 0; i < n; i++) offsets.push(dv.getUint32(8 + i * 4));
      return { version: p[0], offsets };
    }
    case 'co64': {
      const n = dv.getUint32(4);
      const offsets = [];
      for (let i = 0; i < n; i++) {
        offsets.push(dv.getUint32(8 + i * 8) * 0x100000000 + dv.getUint32(12 + i * 8));
      }
      return { version: p[0], offsets };
    }
    default:
      throw new Error('table inconnue : ' + box.type);
  }
}

function writeStts(t) {
  const p = new Uint8Array(8 + t.entries.length * 8);
  const dv = new DataView(p.buffer);
  dv.setUint32(4, t.entries.length);
  t.entries.forEach(([count, delta], i) => {
    dv.setUint32(8 + i * 8, count);
    dv.setUint32(12 + i * 8, delta);
  });
  return p;
}

function writeStsc(t) {
  const p = new Uint8Array(8 + t.entries.length * 12);
  const dv = new DataView(p.buffer);
  dv.setUint32(4, t.entries.length);
  t.entries.forEach(([first, per, desc], i) => {
    dv.setUint32(8 + i * 12, first);
    dv.setUint32(12 + i * 12, per);
    dv.setUint32(16 + i * 12, desc);
  });
  return p;
}

/* Toujours ecrit sous forme de table, meme si toutes les tailles sont
   egales : le bourrage introduit forcement une taille differente. */
function writeStsz(t) {
  const p = new Uint8Array(12 + t.sizes.length * 4);
  const dv = new DataView(p.buffer);
  dv.setUint32(4, 0);
  dv.setUint32(8, t.sizes.length);
  t.sizes.forEach((s, i) => dv.setUint32(12 + i * 4, s));
  return p;
}

/* `stco` tant que tout tient sur 32 bits, `co64` au-dela. La bascule change
   la taille de `moov`, d'ou la boucle de convergence dans applyUploadMethod. */
function writeChunkOffsets(box, offsets) {
  const needs64 = offsets.some((o) => o > u32max);
  if (needs64) {
    const p = new Uint8Array(8 + offsets.length * 8);
    const dv = new DataView(p.buffer);
    dv.setUint32(4, offsets.length);
    offsets.forEach((o, i) => {
      dv.setUint32(8 + i * 8, Math.floor(o / 0x100000000));
      dv.setUint32(12 + i * 8, o >>> 0);
    });
    box.type = 'co64';
    box.payload = p;
  } else {
    const p = new Uint8Array(8 + offsets.length * 4);
    const dv = new DataView(p.buffer);
    dv.setUint32(4, offsets.length);
    offsets.forEach((o, i) => dv.setUint32(8 + i * 4, o));
    box.type = 'stco';
    box.payload = p;
  }
}

/* ── ecriture ───────────────────────────────────────────────────────────── */

function boxSize(box) {
  const body = box.children
    ? box.children.reduce((n, c) => n + boxSize(c), 0)
    : box.payload.length;
  return 8 + body;
}

function writeBox(box, out, at) {
  const size = boxSize(box);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(at, size);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = box.type.charCodeAt(i);
  let off = at + 8;
  if (box.children) for (const c of box.children) off = writeBox(c, out, off);
  else {
    out.set(box.payload, off);
    off += box.payload.length;
  }
  return off;
}

/* ── methode ────────────────────────────────────────────────────────────── */

/**
 * Applique la methode a un MP4/MOV en memoire.
 *
 * @param {Uint8Array|ArrayBuffer} input  fichier source
 * @param {object} [options]
 * @param {number} [options.fpsMultiplier=10]  facteur applique au nombre
 *        d'echantillons audio. 1 desactive le patch FPS et ne laisse que le
 *        faststart + la suppression des edit lists.
 * @param {boolean} [options.stripEditLists=true]
 * @param {boolean} [options.faststart=true]  place `moov` avant les donnees.
 *        A false, `moov` reste apres le `mdat` comme dans le fichier source.
 * @returns {{data: Uint8Array, report: object}}
 */
function applyUploadMethod(input, options) {
  const opts = options || {};
  const fpsMultiplier = opts.fpsMultiplier === undefined ? 10 : opts.fpsMultiplier;
  const stripEditLists = opts.stripEditLists !== false;
  const faststart = opts.faststart !== false;

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const top = parseBoxes(bytes, view, 0, bytes.length);
  if (!top.length) throw new Error("Fichier illisible : aucune boite MP4 trouvee.");

  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error("Pas de boite 'moov' : ce fichier n'est pas un MP4 exploitable.");

  /* Les boites de donnees suivent le moov, dans leur ordre d'origine. On
     jette `free`/`skip` (du rembourrage) et le `moov`/`ftyp` deja places. */
  const carried = top.filter(
    (b) => b !== ftyp && b !== moov && b.type !== 'free' && b.type !== 'skip'
  );

  const traks = moov.children.filter((b) => b.type === 'trak');
  if (!traks.length) throw new Error("Aucune piste dans le fichier.");

  if (stripEditLists) {
    for (const trak of traks) trak.children = trak.children.filter((b) => b.type !== 'edts');
  }

  /* Pistes : on releve le type de media et les tables a reecrire. */
  const tracks = traks.map((trak) => {
    const stbl = findPath(trak, ['mdia', 'minf', 'stbl']);
    const hdlr = findPath(trak, ['mdia', 'hdlr']);
    const handler = hdlr ? typeOf(hdlr.payload, 8) : '';
    const chunkBox = stbl && (findChild(stbl, 'stco') || findChild(stbl, 'co64'));
    return { trak, stbl, handler, chunkBox, offsets: chunkBox ? readTable(chunkBox).offsets : [] };
  });

  const audio = tracks.find((t) => t.handler === 'soun');
  const report = {
    tracks: tracks.length,
    hasAudio: !!audio,
    editListsStripped: stripEditLists,
    paddingSamples: 0,
    paddingBytes: 0,
    audioSamplesBefore: 0,
    audioSamplesAfter: 0,
  };

  /* Patch FPS : on gonfle la table d'echantillons audio. */
  let padCount = 0;
  if (audio && audio.stbl && fpsMultiplier > 1) {
    const stts = findChild(audio.stbl, 'stts');
    const stsc = findChild(audio.stbl, 'stsc');
    const stsz = findChild(audio.stbl, 'stsz');
    if (!stts || !stsc || !stsz || !audio.chunkBox) {
      throw new Error("Piste audio incomplete : tables d'echantillons manquantes.");
    }
    const tStts = readTable(stts);
    const tStsc = readTable(stsc);
    const tStsz = readTable(stsz);

    const before = tStsz.sizes.length;
    padCount = Math.max(0, Math.round(before * (fpsMultiplier - 1)));

    if (padCount > 0) {
      /* Duree 1 tick par echantillon : le bourrage n'ajoute que
         padCount/timescale seconde a la table, soit quelques dizaines de ms. */
      tStts.entries.push([padCount, 1]);
      for (let i = 0; i < padCount; i++) tStsz.sizes.push(PAD_SIZE);
      /* Tous les echantillons de bourrage tiennent dans un seul chunk
         supplementaire, ajoute apres le dernier chunk existant. */
      tStsc.entries.push([audio.offsets.length + 1, padCount, 1]);

      stts.payload = writeStts(tStts);
      stsc.payload = writeStsc(tStsc);
      stsz.payload = writeStsz(tStsz);
      audio.offsets = audio.offsets.slice();
      audio.offsets.push(0);      // valeur reelle fixee apres calcul de la mise en page
      audio.padChunkIndex = audio.offsets.length - 1;
    }

    report.audioSamplesBefore = before;
    report.audioSamplesAfter = before + padCount;
  }
  report.paddingSamples = padCount;
  report.paddingBytes = padCount * PAD_SIZE;

  /* Mise en page : ftyp | moov | boites de donnees | bourrage.
     La taille de `moov` depend des offsets qu'il contient, qui dependent de
     la taille de `moov`. On itere jusqu'a stabilisation — deux tours
     suffisent sauf bascule stco -> co64. */
  const ftypSize = ftyp ? boxSize(ftyp) : 0;
  let moovSize = boxSize(moov);
  let layout = null;

  for (let pass = 0; pass < 8; pass++) {
    let cursor = ftypSize + (faststart ? moovSize : 0);
    const placed = carried.map((b) => {
      const entry = { box: b, oldStart: b.fileStart, newStart: cursor, size: b.dataEnd - b.fileStart };
      cursor += entry.size;
      return entry;
    });
    const moovStart = faststart ? ftypSize : cursor;
    if (!faststart) cursor += moovSize;
    const padStart = cursor;

    /* Un offset de chunk pointe dans une boite de donnees : il glisse du
       meme delta que la boite qui le contient. */
    const remap = (o) => {
      for (const e of placed) {
        if (o >= e.oldStart && o < e.oldStart + e.size) return o - e.oldStart + e.newStart;
      }
      return o;   // hors des boites reportees : laisse tel quel plutot que de casser
    };

    for (const t of tracks) {
      if (!t.chunkBox) continue;
      const next = t.offsets.map(remap);
      if (t === audio && t.padChunkIndex !== undefined) next[t.padChunkIndex] = padStart;
      writeChunkOffsets(t.chunkBox, next);
    }

    const newMoovSize = boxSize(moov);
    layout = { placed, moovStart, padStart, total: padStart + padCount * PAD_SIZE };
    if (newMoovSize === moovSize) break;
    moovSize = newMoovSize;
  }

  /* Serialisation. */
  const out = new Uint8Array(layout.total);
  if (ftyp) writeBox(ftyp, out, 0);
  writeBox(moov, out, layout.moovStart);
  for (const e of layout.placed) {
    out.set(bytes.subarray(e.oldStart, e.oldStart + e.size), e.newStart);
  }
  for (let i = 0; i < padCount; i++) out.set(PAD_SAMPLE, layout.padStart + i * PAD_SIZE);

  report.bytesIn = bytes.length;
  report.bytesOut = out.length;
  return { data: out, report };
}

/* Nom de sortie : « clip.mp4 » -> « clip_vault.mp4 ». */
function methodFileName(name, suffix) {
  const tag = suffix || '_vault';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name + tag + '.mp4';
  return name.slice(0, dot) + tag + name.slice(dot);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyUploadMethod, methodFileName, PAD_SAMPLE };
}
if (typeof window !== 'undefined') {
  window.VaultUploadMethod = { applyUploadMethod, methodFileName };
}
