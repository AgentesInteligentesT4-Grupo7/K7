import fs from 'node:fs';
import path from 'node:path';
import { MODULES } from '../modules/registry.js';
import { PROFILE_NAME_PATTERN, ProfileError } from './ProfileManifest.js';

/** Arquivos de um perfil novo (spec RF-12): pronto para editar e virar um repositório próprio. */
export function profileTemplate(name: string, playerVersion: string): Record<string, string> {
  const major = playerVersion.split('.')[0] ?? '1';
  return {
    'perfil.yaml': `# Manifesto do perfil "${name}" (spec profiles-modules RF-03).
# Perfis são só conteúdo: nada aqui é executado.
nome: ${name}
versao: 0.1.0
descricao: Descreva em uma frase o que este perfil faz.
requer:
  tocador: ">=${major}.0"

identidade:
  nome: ${name.charAt(0).toUpperCase()}${name.slice(1)}
  emoji: 🤖
  dono: Você
  proposito: assistente de ${name}
  instrucoes: |
    Instruções fixas de comportamento deste agente.

# Módulos do tocador que este perfil liga:
${MODULES.map((m) => `#   ${m.id.padEnd(12)} ${m.descricao}`).join('\n')}
modulos:
  arquivos: {}

# Canais: telegram, terminal, web (chat no navegador). Padrão: telegram e terminal
canais: [terminal]

# publico | pessoal | local (local = só modelos na sua GPU)
privacidade: publico

# Limites do agente (opcional; spec guardrails). Descomente o que precisar:
# guardrails:
#   injecao: avisar                 # off | avisar | bloquear
#   verificar_com_llm: false        # confirma injeção e tópico com o LLM de roteamento
#   dados_pessoais: mascarar        # off | mascarar | bloquear (CPF, e-mail, telefone, chaves…)
#   proibidas: { palavras: [], acao: corrigir }   # corrigir | refazer | bloquear
#   topicos: { permitidos: [], proibidos: [], acao: bloquear }
#   abster: [saude, juridico, financeiro]

# Variáveis que o .env do perfil precisa ter (o instalador avisa as que faltam)
variaveis: {}
`,
    'skills/exemplo/SKILL.md': `---
name: exemplo
description: Skill de exemplo do perfil ${name}. Troque a descrição pelo pedido que deve ativá-la.
---

# Exemplo

Você é {{AGENT_NAME}}, {{AGENT_PURPOSE}} de {{OWNER_NAME}}.

Descreva aqui, passo a passo, como o agente deve agir quando esta skill for escolhida.
`,
    'ferramentas/exemplo.yaml.off': `# Ferramenta HTTP declarativa (módulo "http"): renomeie para .yaml e ligue "http" em modulos.
nome: cotacao_moeda
descricao: Cotação atual de moedas em reais (ex.: USD-BRL, EUR-BRL)
url: https://economia.awesomeapi.com.br/json/last/{pares}
parametros:
  pares: { tipo: string, descricao: "Pares de moedas, ex.: USD-BRL" }
# fixos: { chave: valor }                                              # parâmetros sempre enviados
# autenticacao: { tipo: header, nome: X-Api-Key, variavel: MINHA_API_KEY }   # chave no .env
# resposta: { campos: [USDBRL.bid], limite_kb: 20 }
`,
    '.env.example': `# Segredos deste perfil (copie para .env; o .env nunca vai para o Git).
# Valores aqui sobrescrevem o .env do tocador.

# Só se o perfil usar o canal telegram: um bot próprio (@BotFather)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_ALLOWED_USER_IDS=
`,
    '.gitignore': '.env\ndados/\n',
    'README.md': `# Perfil ${name}

Fita do ParreiraClaw. Rodar:

\`\`\`bash
npm run chat -- --perfil ${name}   # terminal
npm run dev -- --perfil ${name}    # bot (se o canal telegram estiver ligado)
\`\`\`

- \`perfil.yaml\`: identidade, módulos, canais e variáveis.
- \`skills/\`: skills próprias (sobrescrevem as dos módulos com o mesmo nome).
- \`evals/\`: conjuntos de avaliação próprios (opcional).
- \`.env\`: segredos (fora do Git).
`,
  };
}

export function createProfile(profilesDir: string, name: string, playerVersion: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) throw new ProfileError(`Nome inválido: "${name}" (letras minúsculas, números e hífen)`);
  const dir = path.join(profilesDir, name);
  if (fs.existsSync(dir)) throw new ProfileError(`Já existe ${dir}`);
  for (const [file, content] of Object.entries(profileTemplate(name, playerVersion))) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}
