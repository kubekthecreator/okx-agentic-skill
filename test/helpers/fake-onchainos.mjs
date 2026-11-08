// Fake `onchainos` CLI for offline tests, two modes in one file.
// Preload mode (FAKE_ONCHAINOS_LOG set): a child `node swap quote ...` loads this via --import, logs argv, answers from the scenario file, exits.
// Helper mode: useFakeOnchainos(dir) points ONCHAINOS_CLI at node + this preload. With no env set (plain `node --test`) the file does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const readLog = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

if (process.env.FAKE_ONCHAINOS_LOG) {
  const log = process.env.FAKE_ONCHAINOS_LOG;
  const argv = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  const key = `${argv[0]} ${argv[1]}`;
  const prior = readLog(log).filter((c) => c.key === key).length;
  fs.appendFileSync(log, `${JSON.stringify({ key, argv })}\n`);
  const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_ONCHAINOS_SCENARIO, 'utf8'));
  const list = scenario[key] || [{ exit: 1, stdout: { ok: false, msg: `no_fake_for:${key}` } }];
  const r = list[Math.min(prior, list.length - 1)];
  fs.writeSync(1, typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout));
  process.exit(r.exit ?? 0);
}

export function useFakeOnchainos(dir) {
  const logFile = path.join(dir, 'calls.jsonl');
  const scenarioFile = path.join(dir, 'scenario.json');
  const preload = `--import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`;
  process.env.ONCHAINOS_CLI = process.execPath;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ');
  process.env.FAKE_ONCHAINOS_LOG = logFile;
  process.env.FAKE_ONCHAINOS_SCENARIO = scenarioFile;
  return {
    scenario(obj) {
      fs.writeFileSync(scenarioFile, JSON.stringify(obj));
      fs.rmSync(logFile, { force: true });
    },
    calls: () => readLog(logFile).map((c) => c.argv),
  };
}
