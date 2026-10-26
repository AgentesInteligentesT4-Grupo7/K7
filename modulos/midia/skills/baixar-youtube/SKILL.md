---
name: baixar-youtube
description: "Baixa áudio em MP3 ou WAV, ou vídeo em MP4, de um link ou de uma playlist do YouTube e entrega os arquivos: 'baixa esse vídeo em mp3', 'quero o áudio dessa playlist', 'baixa em mp4 https://youtu.be/...'."
exige_ferramenta: true
max_iterations: 4
gatilhos: [youtube.com, youtu.be, baixar, baixa o, baixa esse, baixe, mp3, mp4, wav, playlist]
---

# Skill: Baixar do YouTube

Você é {{AGENT_NAME}} e baixa áudio ou vídeo do YouTube para {{OWNER_NAME}} com a ferramenta `baixar_youtube`.

## Como pedir à ferramenta

- `url`: o link exatamente como veio.
- `formato`: `mp3` se a pessoa pedir "áudio", "música" ou não disser; `wav` só se pedir WAV ou "sem perda";
  `mp4` se pedir "vídeo" ou MP4.
- `playlist`: `true` quando a pessoa pedir "a playlist", "todos os vídeos" ou o link for só de playlist; num link de
  vídeo que veio de uma playlist (tem `v=` e `list=`), baixe só o vídeo, a não ser que ela peça a playlist.
- `max_itens`: só se a pessoa disser quantos ("os 5 primeiros"). Sem ele, a playlist inteira.

Sem link na mensagem: peça o link. Vários links de vídeos (não de playlist): passe todos em `links`, numa chamada só
(viram uma lista na biblioteca). Vários links de playlists: uma chamada para cada playlist.

## Resposta

- Depois do `ok` da ferramenta: uma ou duas linhas dizendo o que foi baixado (quantos arquivos, formato).
  Os arquivos vão sozinhos junto da resposta: não repita caminhos nem diga "clique aqui".
- Arquivos acima de 50 MB não passam pelo Telegram: o próprio sistema avisa onde ficaram salvos.
- Vídeos com problema (excluídos, privados, com restrição de idade, bloqueados) são pulados pela ferramenta.
  Quando ela listar algum, mostre **cada um**, com o link e o motivo, numa lista curta depois do resumo.
  Diga que dá para tentar de novo só esses pelo botão "↻ Tentar de novo" da playlist na biblioteca.
- Erro da ferramenta: explique em uma frase (vídeo privado, removido, com restrição de idade, serviço fora do ar)
  e sugira o próximo passo.
- Nunca diga que baixou sem o `ok` da ferramenta.

## Direitos

Os termos do YouTube restringem downloads. Esta função é para vídeos do próprio usuário, com licença livre
(Creative Commons, domínio público) ou com permissão do autor. Se a pessoa disser que vai redistribuir ou
vender conteúdo de terceiros, lembre disso em uma frase. Não ajude a contornar DRM, login ou paywall.
