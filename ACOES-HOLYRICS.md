# Ações do Holyrics usadas pelo app

Lista de **todas** as ações da API do Holyrics que este app chama, e o que cada uma faz aqui.
Nenhuma outra ação deve ser chamada sem antes entrar nesta lista.

- Referência oficial: https://github.com/holyrics/API-Server (README.md)
- Todas as chamadas passam por `HolyricsClient.request` ([src/holyricsClient.ts](src/holyricsClient.ts)):
  `POST http://[ip]:[porta]/api/{Ação}?token=...`, com os parâmetros no corpo em JSON.
- **Plan** = a ação exige assinatura do Holyrics Plan.
  **Permissão avançada** = é preciso liberar no Holyrics, em *menu arquivo > configurações > avançado > javascript > configurações > permissões avançadas*.

> **Mantenha este arquivo atualizado.** Sempre que uma ação for adicionada, removida ou mudar de
> uso no código (`client.request('...')`), atualize a tabela e a seção do fluxo correspondente.

## Resumo

| Ação | Versão mín. | Requisitos | Onde | Efeito no Holyrics |
| --- | :---: | --- | --- | --- |
| `GetVersion` | 2.22.0 | — | healthcheck, preparar | Leitura |
| `GetHolyricsPlanInfo` | 2.28.0 | — | healthcheck | Leitura |
| `GetAPIServerInfo` | 2.26.0 | — | healthcheck | Leitura |
| `GetSongs` | 2.21.0 | — | sincronizar catálogo | Leitura |
| `GetLyrics` | 2.19.0 | — | sincronizar catálogo | Leitura |
| `GetTexts` | 2.21.0 | — | sincronizar catálogo | Leitura |
| `GetThemes` | 2.27.0 | — | sincronizar catálogo | Leitura |
| `GetScripts` | 2.21.0 | — | sincronizar catálogo | Leitura |
| `GetBackgrounds` | 2.19.0 | — | sincronizar catálogo | Leitura |
| `GetSongGroups` | 2.24.0 | — | sincronizar catálogo | Leitura |
| `GetBibleVersionsV2` | 2.23.0 | — | sincronizar catálogo | Leitura |
| `GetSchedules` | 2.19.0 (`metadata.event` 2.25.0) | — | preparar | Leitura |
| `CreateSong` | — | Plan + permissão avançada | criar músicas pendentes | Cria música |
| `CreateEvent` | — | Plan + permissão avançada | preparar | Cria evento |
| `AddToPlaylist` | 2.20.0 (`event_id` 2.26.0) | Plan (com `event_id`) | preparar | Adiciona itens à playlist do evento |
| `SetCurrentSchedule` | 2.26.0 | Plan | preparar | **Troca o culto selecionado na interface** |
| `DeleteEvent` | — | Plan + permissão avançada | preparar | **Apaga evento** |

## Por fluxo

### Healthcheck — `statusConexao` ([src/holyrics/healthcheck.ts](src/holyrics/healthcheck.ts))
IPC `holyrics:healthcheck`. Só leitura, em paralelo:
- `GetVersion`: versão do Holyrics em execução.
- `GetHolyricsPlanInfo`: tipo da assinatura (Plan).
- `GetAPIServerInfo`: se o API Server local está habilitado (`enabled_local`).

### Sincronizar catálogo — `sincronizarCatalogo` ([src/holyrics/catalog.ts](src/holyrics/catalog.ts))
IPC `holyrics:sincronizar-catalogo`. Só leitura. O resultado vai para o `state.catalogoLocal` e para o S3.
- `GetSongs` (`fields: id,title,artist,author,key,bpm,groups,extras`): músicas, sem a letra.
- `GetLyrics` (`id`): uma chamada por música, até 5 ao mesmo tempo, depois do `GetSongs`. Guarda só o
  `text` de cada slide em `slides`, com as quebras de linha padronizadas em `\n` e sem os slides ou
  linhas que começam com `//`. Se a chamada falhar, a sincronização não falha, e a música é salva
  sem `slides`.
- `GetTexts` (`fields: id,title,folder,slides`): textos.
- `GetThemes`: temas.
- `GetScripts`: scripts.
- `GetBackgrounds`: temas e planos de fundo.
- `GetSongGroups`: grupos de música.
- `GetBibleVersionsV2`: versões da Bíblia. `GetBibleVersions` está deprecated.

### Criar músicas pendentes — `criarMusicasPendentes` ([src/holyrics/pendingSongs.ts](src/holyrics/pendingSongs.ts))
IPC `holyrics:criar-pendentes`.
- `CreateSong` (`title`, `artist`, `slides`, `extras.musica_id`): cria a música. Se o catálogo local já
  tem uma música com o mesmo `extras.musica_id`, reaproveita essa e não cria de novo.

### Preparar — `prepararEvento` ([src/holyrics/prepare.ts](src/holyrics/prepare.ts))
IPC `holyrics:preparar`. Monta um evento novo sem alterar o culto selecionado na interface enquanto
a playlist está sendo montada. Só no final o evento novo passa a ser o selecionado.
1. `GetVersion`: bloqueia a preparação se o Holyrics for anterior à 2.26.0, porque essas versões
   ignoram `event_id` e editariam a playlist selecionada.
2. `CreateEvent` (`name`): **sempre** cria um evento novo. O id novo é devolvido em `holyricsEventId`.
3. `AddToPlaylist` (`items`, `event_id`): adiciona todos os itens à playlist do evento novo,
   em ordem inversa à do manifest (correção empírica, ver o comentário no código).
4. `GetSchedules` (`month`, `year`): relê a playlist do evento, procurando pelo
   `metadata.event.id`, para guardar no snapshot o id que o Holyrics deu a cada item. Se falhar,
   a preparação não falha.
5. `SetCurrentSchedule` (`event_id`): deixa o evento novo selecionado na interface.
6. `DeleteEvent` (`id`): apaga o evento da preparação anterior (`params.holyricsEventId`). Se
   falhar, a preparação não falha, e o evento antigo fica sobrando no Holyrics.

Regra: **não** chamar `SetCurrentSchedule` antes do passo 5, nem `GetMediaPlaylist` na preparação.
`GetMediaPlaylist` não aceita `event_id` e lê a playlist do culto selecionado.
