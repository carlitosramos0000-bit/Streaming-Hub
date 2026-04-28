# Streaming Hub

Aplicacao web local para IPTV, VOD e series com login simples via `host`, `username` e `password`, inspirada na experiencia do Smarters Player.

## O que ja faz

- Login por Xtream Codes API.
- Separacao clara entre `Live TV`, `Filmes`, `Series` e `Favoritos`.
- Player lateral persistente para continuares a navegar enquanto ves conteudo.
- Favoritos e progresso guardados localmente por conta.
- Proxy local para API, imagens e streams, reduzindo problemas de CORS.

## Como arrancar

### Opcao 1: PowerShell

```powershell
.\run-local.ps1
```

### Opcao 2: Node

```powershell
node server.js
```

Se o `node` nao estiver disponivel globalmente, o script `run-local.ps1` tenta usar o runtime do Codex.

Depois abre:

[http://localhost:3200](http://localhost:3200)

## Notas importantes

- A app espera um provider compativel com Xtream Codes API.
- Streams HLS (`.m3u8`) tendem a funcionar melhor no browser.
- Alguns providers usam containers/codecs como `mkv`, `avi` ou `ts`; nesses casos a reproducao pode depender do suporte do browser.
