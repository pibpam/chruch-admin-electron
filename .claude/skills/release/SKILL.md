---
name: release
description: Publica uma nova versão do ChurchAdmin — confere a última release do GitHub, atualiza a version no package.json, commita, faz push e cria a release com tag. Use quando o usuário pedir "release", "nova versão", "publicar versão" ou "/release [patch|minor|major|x.y.z]".
---

# Release

Fluxo: verificar release atual → alterar `version` → commit → push → criar release → o workflow `.github/workflows/release-windows.yml` builda no Windows e anexa os artefatos.

Argumento opcional: `patch` (padrão), `minor`, `major` ou uma versão exata (`1.2.0`).

## Passos

1. **Pré-checagens**
   - `git branch --show-current` deve ser `main`; se não for, avise e pare.
   - `git status --short`: se houver alterações rastreadas não commitadas além do `package.json`, mostre ao usuário e pergunte se devem entrar no commit ou se deve parar. Ignore arquivos não rastreados (`??`).
   - `git fetch --tags` e confirme que `main` não está atrás de `origin/main`.

2. **Verificar a release atual**
   - `gh release list --limit 5` e `gh release view --json tagName,publishedAt,name` (a "Latest").
   - Leia a `version` do `package.json`.
   - A fonte da verdade é a **maior** entre a última release/tag e o `package.json` (eles podem divergir: o `package.json` pode estar atrás da release). Calcule a próxima versão a partir dessa maior.
   - Se a versão alvo já existir como tag/release, pare e avise.

3. **Definir a nova versão** conforme o argumento (padrão `patch`). Mostre ao usuário `versão atual → nova versão` e **peça confirmação** antes de seguir (commit, push e release são ações externas).

4. **Alterar a version** em `package.json` (Edit no campo `"version"`). O projeto usa yarn (`yarn.lock`), não há `package-lock.json`; não use `npm version`.

5. **Commitar** só o `package.json` (e o que o usuário aprovou no passo 1), no padrão do repo (Conventional Commits em português):
   ```
   git add package.json
   git commit -m "chore: atualizar versão para X.Y.Z"
   ```
   Termine a mensagem com a linha de atribuição indicada pelo sistema (Co-Authored-By), se houver.

6. **Push**: `git push origin main`. A tag da release precisa apontar para um commit cujo `package.json` já está na versão nova (o workflow falha se a versão e a tag divergirem).

7. **Criar a release** com tag `vX.Y.Z` e notas geradas a partir dos commits desde a última tag. Não anexe arquivos aqui: o build roda no GitHub Actions (runner Windows), porque o maker Squirrel (`Setup.exe`, `.nupkg`, `RELEASES`) não roda no macOS sem Wine/Mono.
   ```
   gh release create vX.Y.Z --target main --title "vX.Y.Z" --generate-notes
   ```
   Não é `prerelease`. Publicar a release dispara o workflow.

8. **Acompanhar o workflow e conferir os artefatos**
   ```
   gh run list --workflow release-windows.yml --limit 1
   gh run watch <id> --exit-status
   gh release view vX.Y.Z --json assets -q '.assets[].name'
   ```
   Devem aparecer `ChurchAdmin-X.Y.Z.Setup.exe`, `church_admin_electron-X.Y.Z-full.nupkg`, `RELEASES` e `ChurchAdmin-win32-x64-X.Y.Z.zip`. Sem o `.nupkg` e o `RELEASES` o update automático não funciona. Se o workflow falhar, mostre o motivo (`gh run view <id> --log-failed`) e avise o usuário; a release fica sem artefatos. Para refazer: corrija e rode `gh workflow run release-windows.yml -f tag=vX.Y.Z`.

9. **Relatar**: versão anterior, nova versão, hash do commit, resultado do workflow, artefatos anexados (e o que ficou de fora) e a URL da release (`gh release view vX.Y.Z --json url -q .url`).

## Observações

- Não use `yarn publish` (electron-forge) nem rode `make-win` local: o build oficial é o do workflow.
- Se algum passo falhar, pare e relate; não use `--force` nem apague tags sem pedido explícito.
