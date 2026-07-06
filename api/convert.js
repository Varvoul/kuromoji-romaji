const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DynamicDictionaries = require("kuromoji/src/dict/DynamicDictionaries");
const Tokenizer = require("kuromoji/src/Tokenizer");

let tokenizerPromise = null;

function getDictPath() {
  const strategies = [
    () => path.join(__dirname, "..", "node_modules", "kuromoji", "dict"),
    () => {
      const p = require.resolve("kuromoji");
      return path.join(path.dirname(p), "dict");
    },
    () => path.join(process.cwd(), "node_modules", "kuromoji", "dict"),
    () => path.join(__dirname, "node_modules", "kuromoji", "dict"),
  ];
  for (const fn of strategies) {
    try { return fn(); } catch (e) { /* continue */ }
  }
  return path.join(process.cwd(), "node_modules", "kuromoji", "dict");
}

function loadGzippedFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) return reject(err);
      zlib.gunzip(data, (err2, decompressed) => {
        if (err2) return reject(err2);
        resolve(decompressed);
      });
    });
  });
}

async function buildDictionaries(dictPath) {
  const files = await Promise.all([
    loadGzippedFile(path.join(dictPath, "base.dat.gz")),
    loadGzippedFile(path.join(dictPath, "check.dat.gz")),
    loadGzippedFile(path.join(dictPath, "tid.dat.gz")),
    loadGzippedFile(path.join(dictPath, "tid_pos.dat.gz")),
    loadGzippedFile(path.join(dictPath, "tid_map.dat.gz")),
    loadGzippedFile(path.join(dictPath, "cc.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk_pos.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk_map.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk_char.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk_compat.dat.gz")),
    loadGzippedFile(path.join(dictPath, "unk_invoke.dat.gz")),
  ]);

  const dic = new DynamicDictionaries();
  dic.loadTrie(new Int32Array(files[0].buffer), new Int32Array(files[1].buffer));
  dic.loadTokenInfoDictionaries(new Uint8Array(files[2]), new Uint8Array(files[3]), new Uint8Array(files[4]));
  dic.loadConnectionCosts(new Int16Array(files[5].buffer));
  dic.loadUnknownDictionaries(new Uint8Array(files[6]), new Uint8Array(files[7]), new Uint8Array(files[8]), new Uint8Array(files[9]), new Uint32Array(files[10].buffer), new Uint8Array(files[11]));
  return dic;
}

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const dictPath = getDictPath();
      console.log("Loading dictionary from:", dictPath);
      const dic = await buildDictionaries(dictPath);
      console.log("Dictionary loaded successfully");
      return new Tokenizer(dic);
    })();
  }
  return tokenizerPromise;
}

// Build kana-to-romaji map programmatically to avoid encoding issues
function buildKanaMap() {
  const map = {};
  // Hiragana basic
  const hiragana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
  const hiraganaRomaji = "a i u e o ka ki ku ke ko sa shi su se so ta chi tsu te to na ni nu ne no ha hi fu he ho ma mi mu me mo ya yu yo ra ri ru re ro wa wo n";
  hiragana.split("").forEach((ch, i) => { map[ch] = hiraganaRomaji.split(" ")[i]; });

  // Hiragana dakuten/handakuten
  const dakuHira = "がぎぐげござじずぜぞだぢっでどばびぶべぼぱぴぷぺぽ";
  const dakuRomaji = "ga gi gu ge go za ji zu ze zo da di tsu de do ba bi bu be bo pa pi pu pe po";
  dakuHira.split("").forEach((ch, i) => { map[ch] = dakuRomaji.split(" ")[i]; });

  // Katakana basic
  const katakana = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
  const katakanaRomaji = "a i u e o ka ki ku ke ko sa shi su se so ta chi tsu te to na ni nu ne no ha hi fu he ho ma mi mu me mo ya yu yo ra ri ru re ro wa wo n";
  katakana.split("").forEach((ch, i) => { map[ch] = katakanaRomaji.split(" ")[i]; });

  // Katakana dakuten/handakuten
  const dakuKata = "ガギグゲゴザジズゼゾダヂッデドバビブベボパピプペポ";
  const dakuKataRomaji = "ga gi gu ge go za ji zu ze zo da di tsu de do ba bi bu be bo pa pi pu pe po";
  dakuKata.split("").forEach((ch, i) => { map[ch] = dakuKataRomaji.split(" ")[i]; });

  // Digraphs - hiragana
  const hDigr = ["きゃ","きゅ","きょ","しゃ","しゅ","しょ","ちゃ","ちゅ","ちょ","にゃ","にゅ","にょ","ひゃ","ひゅ","ひょ","みゃ","みゅ","みょ","りゃ","りゅ","りょ","ぎゃ","ぎゅ","ぎょ","じゃ","じゅ","じょ","びゃ","びゅ","びょ","ぴゃ","ぴゅ","ぴょ"];
  const hDigrR = ["kya","kyu","kyo","sha","shu","sho","cha","chu","cho","nya","nyu","nyo","hya","hyu","hyo","mya","myu","myo","rya","ryu","ryo","gya","gyu","gyo","ja","ju","jo","bya","byu","byo","pya","pyu","pyo"];
  hDigr.forEach((d, i) => { map[d] = hDigrR[i]; });

  // Digraphs - katakana
  const kDigr = ["キャ","キュ","キョ","シャ","シュ","ショ","チャ","チュ","チョ","ニャ","ニュ","ニョ","ヒャ","ヒュ","ヒョ","ミャ","ミュ","ミョ","リャ","リュ","リョ","ギャ","ギュ","ギョ","ジャ","ジュ","ジョ","ビャ","ビュ","ビョ","ピャ","ピュ","ピョ"];
  kDigr.forEach((d, i) => { map[d] = hDigrR[i]; });

  // Special characters
  map["ー"] = "";
  map["・"] = "";

  return map;
}

const KANA_ROMAJI_MAP = buildKanaMap();

function readingToRomaji(reading) {
  if (!reading) return "";
  let result = "";
  let i = 0;
  while (i < reading.length) {
    // Small tsu - double next consonant
    if (reading[i] === "っ" || reading[i] === "ッ") {
      i++;
      if (i < reading.length) {
        const digraph = reading.substring(i, i + 2);
        if (KANA_ROMAJI_MAP[digraph] !== undefined) {
          const r = KANA_ROMAJI_MAP[digraph];
          if (r.length > 0) result += r[0];
        } else if (KANA_ROMAJI_MAP[reading[i]] !== undefined) {
          const r = KANA_ROMAJI_MAP[reading[i]];
          if (r.length > 0) result += r[0];
        }
      }
      continue;
    }
    // Try 2-char digraph
    if (i + 1 < reading.length) {
      const two = reading.substring(i, i + 2);
      if (KANA_ROMAJI_MAP[two] !== undefined) {
        result += KANA_ROMAJI_MAP[two];
        i += 2;
        continue;
      }
    }
    // Single char
    const ch = reading[i];
    if (KANA_ROMAJI_MAP[ch] !== undefined) {
      result += KANA_ROMAJI_MAP[ch];
    } else {
      result += ch;
    }
    i++;
  }
  return result;
}

async function convertToRomaji(text) {
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(text);
  let romaji = "";
  for (const token of tokens) {
    if (token.reading) {
      romaji += readingToRomaji(token.reading);
    } else if (token.surface_form) {
      romaji += readingToRomaji(token.surface_form);
    }
  }
  return romaji;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { text } = req.query;
  if (!text) {
    return res.status(400).json({ error: "Missing text parameter" });
  }
  try {
    const decodedText = decodeURIComponent(text);
    console.log("Converting:", decodedText);
    const romaji = await convertToRomaji(decodedText);
    return res.status(200).json({ romaji });
  } catch (err) {
    console.error("Conversion failed:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Conversion failed" });
  }
};