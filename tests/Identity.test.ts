import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SystemPromptBuilder } from '../src/agent/SystemPromptBuilder.js';
import { identityFromEnv, renderIdentity } from '../src/config/AgentIdentity.js';
import { Config } from '../src/config/Config.js';
import { SkillLoader } from '../src/skills/SkillLoader.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';

const promo = identityFromEnv({
  AGENT_NAME: 'PromoBot',
  AGENT_EMOJI: '🛒',
  OWNER_NAME: 'Equipe Promo',
  AGENT_PURPOSE: 'assistente de promoções',
  AGENT_INSTRUCTIONS: 'Foque em ofertas de tecnologia.\\nSeja breve.',
});

describe('Identidade configurável do agente', () => {
  it('defaults mantêm o AgroMinds; o .env troca nome, dono e foco', () => {
    const base = identityFromEnv({});
    assert.deepEqual([base.name, base.owner, base.purpose], ['AgroMinds', 'Agro', 'agente pessoal de IA']);
    assert.equal(promo.instructions, 'Foque em ofertas de tecnologia.\nSeja breve.');
    const config = new Config({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', AGENT_NAME: 'PromoBot' });
    assert.equal(config.identity.name, 'PromoBot');
  });

  it('o system prompt usa a identidade e as instruções de foco', () => {
    const prompt = new SystemPromptBuilder(new ToolRegistry(), promo).build({
      availableSkills: [],
      activeSkill: null,
      input: { source: 'text', requiresAudioReply: false },
    });
    assert.match(prompt, /Você é o PromoBot, assistente de promoções de Equipe Promo/);
    assert.match(prompt, /# Foco e instruções do projeto\nFoque em ofertas de tecnologia\.\nSeja breve\./);
    assert.ok(!prompt.includes('AgroMinds'));
  });

  it('SKILL.md com marcadores {{AGENT_NAME}} e {{OWNER_NAME}} é preenchido', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-skills-'));
    fs.mkdirSync(path.join(dir, 's'));
    fs.writeFileSync(path.join(dir, 's', 'SKILL.md'), '---\nname: s\ndescription: "Skill do {{AGENT_NAME}}"\n---\nAutor: {{AGENT_NAME}} para {{ OWNER_NAME }}. Placeholder do usuário {ideia} intacto.');
    const loader = new SkillLoader(dir, promo);
    const [skill] = loader.loadAll();
    assert.equal(skill!.description, 'Skill do PromoBot');
    assert.equal(loader.loadContent(skill!), 'Autor: PromoBot para Equipe Promo. Placeholder do usuário {ideia} intacto.');
    assert.equal(renderIdentity('{{AGENT_EMOJI}} {{AGENT_PURPOSE}}', promo), '🛒 assistente de promoções');
  });
});
