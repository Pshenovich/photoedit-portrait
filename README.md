# PhotoEdit Pro

Портретный редактор в браузере (MediaPipe Face Landmarker). Статика, без сборки.

## Уже развёрнуто

| Где | URL |
|-----|-----|
| Репозиторий | https://github.com/Pshenovich/photoedit-portrait |
| **Vercel** (основной прод) | https://photoedit-portrait.vercel.app |
| **GitHub Pages** (зеркало) | https://pshenovich.github.io/photoedit-portrait/ |

Оба варианта отдают тот же `index.html` по HTTPS.

## Авто-деплой Vercel из GitHub

Первый выклад на Vercel с этой машины прошёл под аккаунтом Vercel **`knazorlov-6551`**, поэтому **привязка GitHub → Vercel** к репозиторию `Pshenovich/photoedit-portrait` не установилась (нет доступа этого Vercel-пользователя к чужому репо).

Чтобы каждый `git push` в `main` сам обновлял прод на Vercel:

1. Войдите на [vercel.com](https://vercel.com) под GitHub-аккаунтом **Pshenovich** (или добавьте Vercel GitHub App к репозиторию).
2. **Add New Project** → импортируйте `Pshenovich/photoedit-portrait`.
3. Preset **Other**, без build-команды, корень проекта — `/`.

Либо оставьте текущий прод на `photoedit-portrait.vercel.app` и обновляйте его командой с машины, где настроен `vercel login`:

```bash
cd /path/to/PhotoEdit
NPM_CONFIG_CACHE=/tmp/npm-cache-photoedit npx vercel@latest deploy --prod --yes --name photoedit-portrait
```

## GitHub Pages

Страницы включены с ветки `main`, путь `/`. Обновление после push может занять 1–2 минуты.

## Локально

```bash
python3 -m http.server 8080
```

Для **ИИ (CometAPI)** нужен деплой на Vercel (или `vercel dev`), а не чистая статика: функция `api/comet-edit.js` проксирует запрос на `https://api.cometapi.com/v1/images/edits`.

1. В проекте Vercel: **Settings → Environment Variables** → `COMET_API_KEY` = ваш ключ с [CometAPI](https://apidoc.cometapi.com).
2. Локально: `vercel dev` в корне репозитория с тем же ключом в `.env` или в окружении.

Без ключа кнопка «ИИ улучшить» вернёт сообщение об отсутствии `COMET_API_KEY`.

## Заметки

- Первый визит тянет WASM/модель MediaPipe из сети.
- Выбор фото с устройства — только по **HTTPS** или `localhost` (продакшен это удовлетворяет).
