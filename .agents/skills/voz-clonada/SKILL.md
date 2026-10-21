---
name: voz-clonada
description: "Gera mensagens de voz com a voz clonada do usuário (ou outra voz cadastrada) a partir de texto: 'fala isso com a minha voz', 'manda um áudio com a minha voz dizendo...', 'grava com minha voz', 'quais vozes eu tenho', 'como cadastro minha voz'."
---

# Skill: Voz Clonada

O usuário cadastrou a própria voz (ou outras vozes autorizadas) para não precisar gravar áudios.
Você transforma texto em voice note com essa voz. Quem sintetiza o áudio é o sistema: você só
indica O QUE será falado e COM QUAL voz, usando a tag abaixo.

## Como gerar o áudio

Escreva o texto a ser falado dentro da tag:

<voz_clonada voz="nome-da-voz">texto exato que será falado</voz_clonada>

- Omita o atributo `voz` para usar a voz padrão: `<voz_clonada>texto</voz_clonada>`.
- Use `listar_vozes_clonadas` quando o usuário citar uma voz pelo nome, quando houver dúvida
  sobre qual usar ou antes de dizer que nenhuma voz existe.

## Regras do texto falado

1. **Texto ditado pelo usuário** ("fala isso com minha voz: Oi, chego às 8"): reproduza
   EXATAMENTE o que ele escreveu, sem corrigir o estilo, sem acrescentar saudações e sem resumir.
   Só corrija erros óbvios de digitação.
2. **Pedido para compor** ("manda um áudio com a minha voz desejando feliz aniversário pra Maria"):
   escreva a mensagem em primeira pessoa, como se fosse o próprio usuário falando, em tom natural
   de áudio de WhatsApp: curta, calorosa, sem formalidade excessiva.
3. Dentro da tag, nada de Markdown, emojis, listas, URLs ou abreviações que soem mal faladas.
   Escreva números e siglas como devem ser pronunciados quando houver ambiguidade
   ("R$ 50" → "cinquenta reais").
4. Fora da tag, escreva no máximo uma linha curta (ex.: "Aqui está 👇") ou nada.
5. Textos muito longos (mais de ~1500 caracteres): divida em mais de uma tag, em pontos naturais.

## Quando não houver voz cadastrada

Explique em 2 a 3 linhas como cadastrar:
- enviar /minhavoz e, em seguida, um áudio de 10 a 30 segundos falando naturalmente; ou
- colocar arquivos .wav, .mp3 ou .ogg na pasta de vozes configurada em VOICE_CLONE_DIR
  (o nome do arquivo vira o nome da voz).

Lembre que o comando rápido `/falar <texto>` também gera o áudio direto, sem passar pelo assistente.

## Uso responsável

Só gere áudio com vozes cadastradas pelo próprio usuário. Recuse pedidos para fazer a voz
parecer outra pessoa real, enganar alguém ou se passar por terceiros.
