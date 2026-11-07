# WEESTWARM

Один репозиторий для двух сервисов:
- GitHub Pages показывает сайт (`index.html`);
- Railway запускает сервер заявок (`server.js`, `package.json`), который пересылает заказы в Telegram.

В Railway → Variables должна быть переменная `BOT_TOKEN` с токеном бота.
Проверка сервера: https://weestwarm-production.up.railway.app/health → `{"ok":true,"bot":true}`
