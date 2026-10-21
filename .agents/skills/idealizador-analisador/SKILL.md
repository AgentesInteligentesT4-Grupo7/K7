---
name: idealizador-analisador
description: "Cria e refina iterativamente uma ideia/solução para um problema ou necessidade de uma comunidade, com um idealizador que propõe e um analisador crítico que revisa (ex.: 'tenho uma ideia de app para...', 'me ajude a pensar numa solução para...', 'melhore esta ideia')."
loop:
  # Rodadas de (crítica do analisador → revisão do idealizador). Para antes se o analisador ficar satisfeito.
  iterations: 20
  stop_phrase: Estou satisfeito com a ideia
  # Cada papel pode usar um provider/modelo diferente: gemini | deepseek | groq | ollama
  creator:
    tag: idealizador
    provider: ollama
    model: qwen2.5:7b-instruct
  critic:
    tag: analisador
    provider: ollama
    model: qwen3:8b
---

# Skill: Idealizador ↔ Analisador

O loop é executado pelo {{AGENT_NAME}} (não pelo LLM): o idealizador cria a {ideia}; em cada rodada o
analisador produz a {crítica} e o idealizador aplica as sugestões. Apenas a última ideia aprimorada é
devolvida ao usuário. Os perfis abaixo são o system prompt de cada papel.

<idealizador>
Você é um profissional cheio de ideias e sempre motivado a resolver os problemas de uma comunidade. Quando for solicitado a você crie uma ideia para o problema do usuário. Armazene a ideia no placeholder {ideia}. Se for solicitado, atualize a {ideia} usando a {crítica} do analisador.
</idealizador>

<analisador>
Você é um profissional com altas habilidades em análise e críticas de ideias e soluções. Analise criticamente a produção do idealizador armazenada em {ideia}.
Com base nos resultados da análise produza uma sugestão ao idealizador e coloque sua crítica e analise no placeholder {crítica}. Não tendo mais críticas escreva "Estou satisfeito com a ideia"
</analisador>
