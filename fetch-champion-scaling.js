const fs = require("fs");

const ROLES = ["top", "jungle", "middle", "bottom", "support"];
const LABELS = ["15-20", "20-25", "25-30", "30-35", "35-40", "40+"];
const OUTPUT_FILE = "./champion-scaling-data.json";
const OUTPUT_JS_FILE = "./champion-scaling-data.js";
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);

const ID_OVERRIDES = {
  MonkeyKing: "wukong"
};

function toLolalyticsSlug(ddragonId) {
  if (ID_OVERRIDES[ddragonId]) return ID_OVERRIDES[ddragonId];
  return ddragonId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveRef(objs, ref) {
  if (typeof ref === "number") return ref;
  if (typeof ref === "string") {
    const index = parseInt(ref, 36);
    if (!Number.isNaN(index) && index >= 0 && index < objs.length) return objs[index];
  }
  return ref;
}

function extractTimeData(qwikData) {
  const objs = qwikData && qwikData._objs;
  if (!Array.isArray(objs)) return null;

  for (let i = 0; i < objs.length; i++) {
    const obj = objs[i];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (!("time" in obj && "timeWin" in obj)) continue;

    const timeObj = resolveRef(objs, obj.time);
    const timeWinObj = resolveRef(objs, obj.timeWin);
    if (!timeObj || !timeWinObj || typeof timeObj !== "object" || typeof timeWinObj !== "object") continue;

    const buckets = ["1", "2", "3", "4", "5", "6", "7"];
    const time = {};
    const timeWin = {};
    let valid = true;

    for (const b of buckets) {
      const t = resolveRef(objs, timeObj[b]);
      const w = resolveRef(objs, timeWinObj[b]);
      if (typeof t !== "number" || typeof w !== "number") {
        valid = false;
        break;
      }
      time[b] = t;
      timeWin[b] = w;
    }

    if (valid) return { time, timeWin };
  }

  return null;
}

function buildRoleStats(timeData) {
  const gameBuckets = [
    timeData.time["2"],
    timeData.time["3"],
    timeData.time["4"],
    timeData.time["5"],
    timeData.time["6"],
    timeData.time["7"]
  ];
  const winBuckets = [
    timeData.timeWin["2"],
    timeData.timeWin["3"],
    timeData.timeWin["4"],
    timeData.timeWin["5"],
    timeData.timeWin["6"],
    timeData.timeWin["7"]
  ];

  const wr = gameBuckets.map((g, i) => {
    if (!g) return 0;
    return Math.round((winBuckets[i] / g) * 10000) / 100;
  });

  const totalGames = gameBuckets.reduce((s, v) => s + v, 0);
  const totalWins = winBuckets.reduce((s, v) => s + v, 0);
  const overallWinRate = totalGames ? Math.round((totalWins / totalGames) * 10000) / 100 : 0;

  return {
    totalGames,
    overallWinRate,
    wr
  };
}

async function fetchChampionRole(slug, role) {
  const url = `https://lolalytics.com/lol/${slug}/build/q-data.json?patch=30&lane=${role}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Referer": `https://lolalytics.com/lol/${slug}/build/?patch=30&lane=${role}`,
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const timeData = extractTimeData(json);
  if (!timeData) throw new Error("Missing time data");
  return buildRoleStats(timeData);
}

async function getChampions() {
  const versionsRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  const versions = await versionsRes.json();
  const latest = versions[0];

  const championsRes = await fetch(
    `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`
  );
  const championsJson = await championsRes.json();

  return Object.values(championsJson.data).map((c) => ({
    id: c.id,
    key: toLolalyticsSlug(c.id),
    name: c.name
  }));
}

async function main() {
  const champions = await getChampions();
  console.log(`Champions from Data Dragon: ${champions.length}`);
  console.log(`Roles: ${ROLES.join(", ")}`);

  const result = {
    metadata: {
      source: "lolalytics.com",
      window: "Last 30 Days",
      tier: "Emerald+",
      queue: "Ranked Solo/Duo",
      labels: LABELS,
      roles: ROLES,
      fetchedAt: new Date().toISOString()
    },
    champions: {}
  };

  for (const champ of champions) {
    result.champions[champ.key] = {
      name: champ.name,
      roles: {}
    };
  }

  const jobs = [];
  for (const champ of champions) {
    for (const role of ROLES) {
      jobs.push({ champ, role });
    }
  }

  let idx = 0;
  let ok = 0;
  let fail = 0;

  async function worker(workerId) {
    while (true) {
      const myIndex = idx;
      idx += 1;
      if (myIndex >= jobs.length) break;

      const job = jobs[myIndex];
      const tag = `${job.champ.key}:${job.role}`;
      try {
        const stats = await fetchChampionRole(job.champ.key, job.role);
        if (stats.totalGames > 0) {
          result.champions[job.champ.key].roles[job.role] = stats;
          ok += 1;
          process.stdout.write(`OK ${tag} (${stats.totalGames})\n`);
        } else {
          fail += 1;
          process.stdout.write(`SKIP ${tag} (0 games)\n`);
        }
      } catch (err) {
        fail += 1;
        process.stdout.write(`FAIL ${tag} (${err.message})\n`);
      }

      if ((myIndex + 1) % 25 === 0) {
        process.stdout.write(`Progress ${myIndex + 1}/${jobs.length} by worker ${workerId}\n`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i + 1));
  await Promise.all(workers);

  for (const key of Object.keys(result.champions)) {
    if (Object.keys(result.champions[key].roles).length === 0) {
      delete result.champions[key];
    }
  }

  // Reduce to primary role only (highest totalGames role per champion)
  for (const [key, champ] of Object.entries(result.champions)) {
    const roleEntries = Object.entries(champ.roles);
    if (!roleEntries.length) {
      delete result.champions[key];
      continue;
    }

    roleEntries.sort((a, b) => b[1].totalGames - a[1].totalGames);
    const [primaryRole, primaryStats] = roleEntries[0];

    result.champions[key] = {
      name: champ.name,
      primaryRole,
      stats: primaryStats
    };
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(
    OUTPUT_JS_FILE,
    `window.__CHAMPION_SCALING_DATA__ = ${JSON.stringify(result)};\n`
  );
  console.log(`Done. Success: ${ok}, Failed: ${fail}`);
  console.log(`Saved ${OUTPUT_FILE}`);
  console.log(`Saved ${OUTPUT_JS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
