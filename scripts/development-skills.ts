import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

// Use the checked repository inventory. Do not follow untrusted filesystem paths.
export function developmentSkillErrors(base: string, files: Set<string>): string[] {
  const errors: string[] = [];
  const read = (path: string) => {
    if (!files.has(path)) throw new Error(`Missing tracked skill resource: ${path}`);
    return readFileSync(resolve(base, path), 'utf8');
  };
  try {
    const source = JSON.parse(read('.claude/skill-sources.json'));
    const names: string[] = [...source.sources.flatMap((item: { skills: string[] }) => item.skills), ...source.firstPartySkills];
    const declared = new Set(names);
    if (declared.size !== names.length) errors.push('Duplicate skill declaration');
    const installed = new Set([...files].flatMap((path) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.slice(1) ?? []));
    for (const name of declared) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
      if (!installed.has(name)) errors.push(`Declared skill is missing: ${name}`);
      else {
        const text = read(`.agents/skills/${name}/SKILL.md`);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
        if (!new RegExp(`^name: ['"]?${name}['"]?\\s*$`, 'm').test(frontmatter) || !/^description:\s*\S/m.test(frontmatter)) errors.push(`Invalid skill entry: ${name}`);
      }
      if (!files.has(`.claude/skills/${name}`)) errors.push(`Claude skill alias is missing: ${name}`);
      else if (!lstatSync(resolve(base, `.claude/skills/${name}`)).isSymbolicLink()) errors.push(`Claude skill alias must be a symlink: ${name}`);
    }
    for (const name of installed) if (!declared.has(name)) errors.push(`Undeclared development skill: ${name}`);
    const lock = JSON.parse(read('skills-lock.json'));
    const portable = new Set<string>(source.portableSkills);
    const local = new Set<string>(source.firstPartySkills);
    for (const name of declared) if (!portable.has(name) && !local.has(name) && !lock.skills[name]) errors.push(`Skill installer record is missing: ${name}`);
    for (const name of Object.keys(lock.skills)) if (!declared.has(name)) errors.push(`Unexpected skill installer record: ${name}`);
    const manifest = JSON.parse(read(source.portableManifest));
    const recorded = new Set<string>();
    for (const item of [...manifest.files, ...manifest.adaptations]) {
      if (!/^\.agents\/skills\/(rust-review|spec-to-code-compliance)\//.test(item.file) || item.file.split('/').includes('..')) throw new Error(`Invalid portable skill path: ${item.file}`);
      recorded.add(item.file);
      const hash = createHash('sha256').update(read(item.file)).digest('hex');
      if (hash !== item.installedSha256) errors.push(`Portable skill hash mismatch: ${item.file}`);
    }
    for (const name of portable) {
      if (!declared.has(name)) errors.push(`Undeclared portable skill: ${name}`);
      for (const path of files) if (path.startsWith(`.agents/skills/${name}/`) && !recorded.has(path)) errors.push(`Unrecorded portable skill resource: ${path}`);
    }
    for (const name of local) if (!declared.has(name)) errors.push(`Undeclared first-party skill: ${name}`);
  } catch (error) { errors.push(`Development skills: ${error}`); }
  return errors;
}
