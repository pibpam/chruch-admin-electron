---
name: release
description: Publica uma nova versão do ChurchAdmin — confere a última release do GitHub, atualiza a version no package.json, commita, faz push e cria a release com tag. Use quando o usuário pedir "release", "nova versão", "publicar versão" ou "/release [patch|minor|major|x.y.z]".
---

# Release

Fluxo: verificar release atual → alterar `version` → commit → build dos pacotes → push → criar release com os artefatos anexados.

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

6. **Build dos pacotes** (depois do commit do bump, antes do push, para o instalador sair com a versão nova e nada ser publicado se o build quebrar):
   ```
   rm -rf out/make
   yarn make-win
   ```
   Isso gera, em `out/make/`, os artefatos do Windows x64 (padrão das releases anteriores):
   - `squirrel.windows/x64/ChurchAdmin-X.Y.Z.Setup.exe`
   - `squirrel.windows/x64/church_admin_electron-X.Y.Z-full.nupkg`
   - `squirrel.windows/x64/RELEASES`
   - `zip/win32/x64/ChurchAdmin-win32-x64-X.Y.Z.zip`

   Confira com `find out/make -type f` o que foi gerado e se os nomes contêm a versão nova. Os artefatos do Squirrel (`Setup.exe`, `.nupkg`, `RELEASES`) precisam de Wine/Mono fora do Windows; em macOS/Linux sem eles o maker pode não gerar nada ou falhar.
   - Se `yarn make-win` falhar, mas o `.zip` existir (ou o usuário mandar seguir), siga **sem o `Setup.exe`** (e sem o que não foi gerado) e avise o usuário do que ficou de fora.
   - Sem `.nupkg` + `RELEASES` na release, o **update automático não funciona** para essa versão (o `update-electron-app` depende deles); avise isso explicitamente.
   - Se não houver nenhum artefato, pare e relate, sem fazer push nem criar a release (o commit fica só local; informe o usuário).

7. **Push** (só com o build OK): `git push origin main`.

8. **Criar a release** com tag `vX.Y.Z` apontando para o commit pushado, notas geradas a partir dos commits desde a última tag e os artefatos que existem anexados:
   ```
   gh release create vX.Y.Z --target main --title "vX.Y.Z" --generate-notes \
     out/make/squirrel.windows/x64/ChurchAdmin-X.Y.Z.Setup.exe \
     out/make/squirrel.windows/x64/church_admin_electron-X.Y.Z-full.nupkg \
     out/make/squirrel.windows/x64/RELEASES \
     out/make/zip/win32/x64/ChurchAdmin-win32-x64-X.Y.Z.zip
   ```
   Passe só os arquivos que de fato existem (omita o `Setup.exe` e demais ausentes, ex.: build em macOS). Não é `prerelease` (o `forge.config.ts` publica com `prerelease: false`). Depois confirme com `gh release view vX.Y.Z --json assets -q '.assets[].name'` quais arquivos foram anexados.

9. **Relatar**: versão anterior, nova versão, hash do commit os artefatos anexados (e o que ficou de fora) e a URL da release (`gh release view vX.Y.Z --json url -q .url`).

## Observações

- Não use `yarn publish` (electron-forge): a release é criada pelo `gh` com os artefatos do `make-win`.
- Se algum passo falhar, pare e relate; não use `--force` nem apague tags sem pedido explícito.
