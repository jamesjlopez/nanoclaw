import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

type Classification = 'owned_by_james' | 'brother_repo' | 'contributed_to' | 'third_party_local_mod' | 'local_only';

interface RepoCard {
  name: string;
  owner?: string;
  fullName?: string;
  localPath?: string;
  remote?: string;
  url?: string;
  classification: Classification;
  source: 'local' | 'github' | 'local+github';
  description?: string;
  homepage?: string;
  defaultBranch?: string;
  primaryLanguage?: string;
  languages: string[];
  topics: string[];
  stack: string[];
  purpose: string;
  purposeSource: 'readme' | 'github' | 'manifest' | 'tree' | 'unknown';
  applicabilityKeywords: string[];
  signals: {
    readme: boolean;
    manifests: string[];
    remote: boolean;
    dirty?: boolean;
    localOnly?: boolean;
    fork?: boolean;
    archived?: boolean;
  };
  recentCommits?: string[];
  lastIndexed: string;
  contentHash: string;
  confidence: number;
}

interface GithubRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  clone_url: string;
  description: string | null;
  homepage: string | null;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  language: string | null;
  topics?: string[];
}

const DEFAULT_ROOTS = [path.join(os.homedir(), 'projects')];
const DEFAULT_USERS = ['jamesjlopez', 'rblopeziv-png'];
const JAMES_LOGIN = 'jamesjlopez';
const BROTHER_LOGIN = 'rblopeziv-png';
const MAX_README_CHARS = 8000;

const env = { ...readEnvFile(['GITHUB_TOKEN', 'REPO_AWARENESS_ROOTS', 'REPO_AWARENESS_GITHUB_USERS']), ...process.env };

async function main(): Promise<void> {
  const roots = parseList(env.REPO_AWARENESS_ROOTS) || DEFAULT_ROOTS;
  const users = parseList(env.REPO_AWARENESS_GITHUB_USERS) || DEFAULT_USERS;
  const now = new Date().toISOString();

  const localCards = scanLocalRepos(roots, now);
  const githubCards = [...(await fetchGithubCards(users, now)), ...(await fetchAuthenticatedGithubCards(now))];
  const cards = mergeCards(localCards, githubCards).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const outDir = path.join(DATA_DIR, 'repo-awareness');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'repos.json'), JSON.stringify({ generatedAt: now, roots, users, repos: cards }, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'repo-awareness.md'), renderRepoAwarenessMarkdown(cards, now));

  for (const groupDir of agentGroupDirs()) {
    fs.writeFileSync(path.join(groupDir, 'repo-awareness.md'), renderGroupRepoAwarenessMarkdown(cards, now));
  }

  console.log(`Indexed ${cards.length} repo cards`);
  console.log(`Wrote ${path.join(outDir, 'repos.json')}`);
}

function parseList(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function scanLocalRepos(roots: string[], now: string): RepoCard[] {
  const cards: RepoCard[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const repoPath of findGitRepos(root)) {
      cards.push(cardFromLocalRepo(repoPath, now));
    }
  }
  return cards;
}

function findGitRepos(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (skipDir(dir, root)) continue;
    if (fs.existsSync(path.join(dir, '.git'))) {
      results.push(dir);
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function skipDir(dir: string, root: string): boolean {
  if (dir === root) return false;
  const base = path.basename(dir);
  return ['node_modules', '.cache', '.venv', 'venv', 'dist', 'build', 'target', 'Library'].includes(base);
}

function cardFromLocalRepo(repoPath: string, now: string): RepoCard {
  const remote = git(repoPath, ['remote', 'get-url', 'origin']);
  const parsed = parseGithubRemote(remote);
  const readme = readReadme(repoPath);
  const manifests = readManifests(repoPath);
  const tree = topLevelTree(repoPath);
  const recentCommits = git(repoPath, ['log', '-5', '--pretty=%s']).split('\n').filter(Boolean);
  const dirty = git(repoPath, ['status', '--porcelain']).trim().length > 0;
  const languages = inferLanguages(repoPath, manifests, tree);
  const stack = inferStack(manifests, languages, tree);
  const purpose = inferPurpose(readme?.content, manifests, tree, parsed?.repo || path.basename(repoPath));
  const classification = classify(parsed?.owner, remote, true);
  const keywords = keywordsFrom([purpose, readme?.content || '', stack.join(' '), languages.join(' '), parsed?.repo || '']);

  return {
    name: parsed?.repo || path.basename(repoPath),
    owner: parsed?.owner,
    fullName: parsed ? `${parsed.owner}/${parsed.repo}` : undefined,
    localPath: repoPath,
    remote: remote || undefined,
    url: parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : undefined,
    classification,
    source: 'local',
    languages,
    topics: [],
    stack,
    purpose,
    purposeSource: readme ? 'readme' : manifests.length > 0 ? 'manifest' : tree.length > 0 ? 'tree' : 'unknown',
    applicabilityKeywords: keywords,
    signals: {
      readme: !!readme,
      manifests: manifests.map((m) => m.name),
      remote: !!remote,
      dirty,
      localOnly: !remote,
    },
    recentCommits,
    lastIndexed: now,
    contentHash: hash([remote, readme?.hash || '', JSON.stringify(manifests), tree.join('\n')].join('\n')),
    confidence: confidence(!!readme, manifests.length, !!remote),
  };
}

async function fetchGithubCards(users: string[], now: string): Promise<RepoCard[]> {
  const cards: RepoCard[] = [];
  for (const user of users) {
    for (const repo of await fetchGithubUserRepos(user)) {
      cards.push(githubCard(repo, now));
    }
  }
  return cards;
}

async function fetchAuthenticatedGithubCards(now: string): Promise<RepoCard[]> {
  if (!env.GITHUB_TOKEN) return [];
  const repos = await fetchGithubRepos(
    'https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated',
  );
  return repos.map((repo) => githubCard(repo, now));
}

async function fetchGithubUserRepos(user: string): Promise<GithubRepo[]> {
  return fetchGithubRepos(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=updated`);
}

async function fetchGithubRepos(firstUrl: string): Promise<GithubRepo[]> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'nanoclaw-repo-awareness',
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${firstUrl}&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`GitHub repo fetch failed for ${firstUrl}: ${res.status} ${res.statusText}`);
      break;
    }
    const batch = (await res.json()) as GithubRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function githubCard(repo: GithubRepo, now: string): RepoCard {
  const languages = repo.language ? [repo.language] : [];
  const topics = repo.topics || [];
  const purpose = repo.description || `GitHub repository ${repo.full_name}`;
  return {
    name: repo.name,
    owner: repo.owner.login,
    fullName: repo.full_name,
    remote: repo.clone_url,
    url: repo.html_url,
    classification: classify(repo.owner.login, repo.clone_url, false),
    source: 'github',
    description: repo.description || undefined,
    homepage: repo.homepage || undefined,
    defaultBranch: repo.default_branch,
    primaryLanguage: repo.language || undefined,
    languages,
    topics,
    stack: inferStack([], languages, []),
    purpose,
    purposeSource: repo.description ? 'github' : 'unknown',
    applicabilityKeywords: keywordsFrom([purpose, topics.join(' '), languages.join(' '), repo.name]),
    signals: {
      readme: false,
      manifests: [],
      remote: true,
      fork: repo.fork,
      archived: repo.archived,
    },
    lastIndexed: now,
    contentHash: hash(JSON.stringify(repo)),
    confidence: repo.description ? 0.6 : 0.35,
  };
}

function mergeCards(localCards: RepoCard[], githubCards: RepoCard[]): RepoCard[] {
  const byKey = new Map<string, RepoCard>();
  for (const card of githubCards) {
    byKey.set(card.fullName?.toLowerCase() || `github:${card.url}`, card);
  }
  for (const local of localCards) {
    const key = local.fullName?.toLowerCase();
    const existing = key ? byKey.get(key) : undefined;
    if (!existing) {
      byKey.set(key || `local:${local.localPath}`, local);
      continue;
    }
    byKey.set(key!, {
      ...existing,
      ...local,
      source: 'local+github',
      description: existing.description,
      homepage: existing.homepage,
      defaultBranch: existing.defaultBranch,
      primaryLanguage: existing.primaryLanguage,
      topics: existing.topics,
      languages: union(local.languages, existing.languages),
      stack: union(local.stack, existing.stack),
      applicabilityKeywords: union(local.applicabilityKeywords, existing.applicabilityKeywords),
      signals: { ...existing.signals, ...local.signals, fork: existing.signals.fork, archived: existing.signals.archived },
      confidence: Math.max(local.confidence, existing.confidence),
    });
  }
  return [...byKey.values()];
}

function readReadme(repoPath: string): { name: string; content: string; hash: string } | null {
  const entry = safeReaddir(repoPath).find((name) => /^readme(\.|$)/i.test(name));
  if (!entry) return null;
  try {
    const content = fs.readFileSync(path.join(repoPath, entry), 'utf8').slice(0, MAX_README_CHARS);
    return { name: entry, content, hash: hash(content) };
  } catch {
    return null;
  }
}

function readManifests(repoPath: string): Array<{ name: string; content: string }> {
  const names = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'Gemfile', 'composer.json'];
  return names.flatMap((name) => {
    const p = path.join(repoPath, name);
    if (!fs.existsSync(p)) return [];
    try {
      return [{ name, content: fs.readFileSync(p, 'utf8').slice(0, 6000) }];
    } catch {
      return [];
    }
  });
}

function topLevelTree(repoPath: string): string[] {
  return safeReaddir(repoPath)
    .filter((name) => !name.startsWith('.') || ['.github'].includes(name))
    .slice(0, 80);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function inferPurpose(readme: string | undefined, manifests: Array<{ name: string; content: string }>, tree: string[], fallback: string): string {
  const readmePurpose = readme ? firstMeaningfulReadmeLine(readme) : null;
  if (readmePurpose) return readmePurpose;
  const packageJson = manifests.find((m) => m.name === 'package.json');
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch {
      // Not valid JSON; ignore.
    }
  }
  if (tree.length > 0) return `Local repository with top-level files: ${tree.slice(0, 10).join(', ')}`;
  return `Repository ${fallback}`;
}

function firstMeaningfulReadmeLine(readme: string): string | null {
  for (const raw of readme.split('\n')) {
    const line = raw
      .replace(/^#+\s*/, '')
      .replace(/\[!\[[^\]]+\]\([^)]+\)\]\([^)]+\)/g, '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
    if (
      !line ||
      line.startsWith('![') ||
      line.startsWith('[![') ||
      line.startsWith('<!--') ||
      line.length < 8 ||
      /^(align|img|picture|source|href|src)\b/i.test(line)
    ) {
      continue;
    }
    return line.slice(0, 240);
  }
  return null;
}

function inferLanguages(repoPath: string, manifests: Array<{ name: string; content: string }>, tree: string[]): string[] {
  const langs = new Set<string>();
  const manifestNames = manifests.map((m) => m.name);
  if (manifestNames.includes('package.json')) langs.add('TypeScript/JavaScript');
  if (manifestNames.includes('pyproject.toml') || manifestNames.includes('requirements.txt')) langs.add('Python');
  if (manifestNames.includes('Cargo.toml')) langs.add('Rust');
  if (manifestNames.includes('go.mod')) langs.add('Go');
  if (tree.some((f) => f.endsWith('.swift'))) langs.add('Swift');
  if (tree.some((f) => f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.hpp'))) langs.add('C++');
  for (const ext of sampleExtensions(repoPath)) {
    if (ext === '.ts' || ext === '.tsx') langs.add('TypeScript');
    if (ext === '.js' || ext === '.jsx') langs.add('JavaScript');
    if (ext === '.py') langs.add('Python');
    if (ext === '.rs') langs.add('Rust');
    if (ext === '.go') langs.add('Go');
    if (ext === '.swift') langs.add('Swift');
  }
  return [...langs].sort();
}

function sampleExtensions(repoPath: string): string[] {
  const exts = new Set<string>();
  const stack = [repoPath];
  let visited = 0;
  while (stack.length > 0 && visited < 300) {
    const dir = stack.pop()!;
    if (skipDir(dir, repoPath) || dir.endsWith(`${path.sep}.git`)) continue;
    for (const entry of safeDirents(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      if (entry.isFile()) {
        visited++;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext) exts.add(ext);
      }
    }
  }
  return [...exts];
}

function safeDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function inferStack(manifests: Array<{ name: string; content: string }>, languages: string[], tree: string[]): string[] {
  const stack = new Set<string>(languages);
  const pkg = manifests.find((m) => m.name === 'package.json');
  if (pkg) {
    try {
      const json = JSON.parse(pkg.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
      for (const name of Object.keys(deps)) {
        if (['react', 'next', 'vite', 'vue', 'svelte', 'express', 'fastify', 'telegram', 'discord.js', 'better-sqlite3'].includes(name)) {
          stack.add(name);
        }
      }
    } catch {
      // Ignore invalid package.json.
    }
  }
  if (tree.includes('Dockerfile')) stack.add('Docker');
  if (tree.includes('.github')) stack.add('GitHub Actions');
  return [...stack].sort();
}

function keywordsFrom(parts: string[]): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you', 'are', 'repo', 'repository']);
  const words = parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length >= 3 && !stop.has(w));
  return [...new Set(words)].slice(0, 32);
}

function classify(owner: string | undefined, remote: string | undefined, isLocal: boolean): Classification {
  if (owner === JAMES_LOGIN) return 'owned_by_james';
  if (owner === BROTHER_LOGIN) return 'brother_repo';
  if (!remote && isLocal) return 'local_only';
  if (isLocal) return 'third_party_local_mod';
  return 'contributed_to';
}

function parseGithubRemote(remote: string): { owner: string; repo: string } | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const match = trimmed.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function confidence(hasReadme: boolean, manifestCount: number, hasRemote: boolean): number {
  return Math.min(0.95, 0.25 + (hasReadme ? 0.35 : 0) + Math.min(manifestCount, 3) * 0.1 + (hasRemote ? 0.15 : 0));
}

function hash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function sortKey(card: RepoCard): string {
  const rank: Record<Classification, string> = {
    owned_by_james: '1',
    brother_repo: '2',
    local_only: '3',
    third_party_local_mod: '4',
    contributed_to: '5',
  };
  return `${rank[card.classification]}:${card.fullName || card.name}`;
}

function agentGroupDirs(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'global')
    .map((entry) => path.join(GROUPS_DIR, entry.name));
}

function renderRepoAwarenessMarkdown(cards: RepoCard[], now: string): string {
  return [
    '# Repo Awareness',
    '',
    `Generated: ${now}`,
    '',
    'This file is generated by `pnpm exec tsx scripts/index-repos.ts`.',
    '',
    renderCards(cards, true),
  ].join('\n');
}

function renderGroupRepoAwarenessMarkdown(cards: RepoCard[], now: string): string {
  return [
    '# Repo Awareness',
    '',
    `Generated: ${now}`,
    '',
    'When ingesting articles, papers, videos, documentation, repositories, or other outside content, compare the new ideas against these repo cards.',
    'If there is a meaningful connection, briefly surface it to James as an applicability note: name the repo, say why it applies, and keep uncertainty explicit.',
    'Do not claim to have inspected full repo contents unless you actually read files from that repo during the turn.',
    '',
    renderCards(cards, false),
  ].join('\n');
}

function renderCards(cards: RepoCard[], includePaths: boolean): string {
  return cards
    .map((card) => {
      const lines = [`## ${card.fullName || card.name}`, '', `- Classification: ${card.classification}`, `- Purpose: ${card.purpose}`];
      if (card.localPath && includePaths) lines.push(`- Local path: ${card.localPath}`);
      if (card.url) lines.push(`- URL: ${card.url}`);
      if (card.stack.length > 0) lines.push(`- Stack: ${card.stack.join(', ')}`);
      if (card.topics.length > 0) lines.push(`- Topics: ${card.topics.join(', ')}`);
      if (card.applicabilityKeywords.length > 0) lines.push(`- Applicability keywords: ${card.applicabilityKeywords.join(', ')}`);
      if (card.signals.localOnly) lines.push('- Note: local-only repo; no GitHub remote detected.');
      if (card.signals.dirty) lines.push('- Note: local working tree has uncommitted changes.');
      return lines.join('\n');
    })
    .join('\n\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
