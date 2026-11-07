<?php
/**
 * WEESTWARM — приём заказов с лендинга и отправка в Telegram.
 * Положите этот файл рядом с index.html на хостинге с PHP (Beget, Timeweb, REG.RU и т.п.).
 */

// ===== НАСТРОЙКИ =====
const BOT_TOKEN = '9140871359:AAFnUJY0yAmCTEVSbrCUpVcqcU19TZ4yfr0';
// ID чата, куда слать заявки. Можно оставить пустым: скрипт сам возьмёт чат,
// из которого вы последним написали боту /start, и запомнит его в chat_id.txt.
const CHAT_ID = '1222770105';
// Ваш домен, чтобы чужие сайты не могли слать заявки (например 'https://weestwarm.ru'). Пусто = без проверки.
const ALLOWED_ORIGIN = '';
// =====================

header('Content-Type: application/json; charset=utf-8');
if (ALLOWED_ORIGIN !== '') {
    header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGIN);
    header('Access-Control-Allow-Headers: Content-Type');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { fail(405, 'Method not allowed'); }
if (ALLOWED_ORIGIN !== '' && isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== ALLOWED_ORIGIN) { fail(403, 'Forbidden'); }

$raw = file_get_contents('php://input');
if (strlen($raw) > 50000) { fail(413, 'Too large'); }
$o = json_decode($raw, true);
if (!is_array($o)) { fail(400, 'Bad JSON'); }

// Антиспам: скрытое поле, которое заполняют только боты
if (!empty($o['website'])) { echo json_encode(['ok' => true, 'id' => rand(1000, 9999)]); exit; }

// Простейшее ограничение частоты: не чаще 1 заявки в 20 секунд с одного IP
$ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
$rl = sys_get_temp_dir() . '/ww_rl_' . md5($ip);
if (file_exists($rl) && time() - filemtime($rl) < 20) { fail(429, 'Too many requests'); }
@touch($rl);

$c = $o['customer'] ?? [];
$d = $o['delivery'] ?? [];
$name  = trim((string)($c['name'] ?? ''));
$phone = trim((string)($c['phone'] ?? ''));
$email = trim((string)($c['email'] ?? ''));
if (mb_strlen($name) < 2 || strlen(preg_replace('/\D/', '', $phone)) < 11) { fail(422, 'Name and phone required'); }
if (empty($o['items']) || !is_array($o['items'])) { fail(422, 'Empty cart'); }

$e = fn($v) => htmlspecialchars(trim((string)$v), ENT_QUOTES, 'UTF-8');
$rub = fn($n) => number_format((float)$n, 0, ',', ' ') . ' ₽';

$orderId = (int)($o['id'] ?? rand(1000, 9999));

// Состав заказа
$items = [];
foreach (array_slice($o['items'], 0, 50) as $i) {
    $qty = max(1, (int)($i['qty'] ?? 1));
    $items[] = '• ' . $e($i['name'] ?? '') . ' (' . $e($i['level'] ?? '') . ') × ' . $qty . ' = ' . $rub(($i['price'] ?? 0) * $qty);
}

// Адрес
if (($d['method'] ?? '') === 'pickup') {
    $delivery = 'Пункт выдачи';
    $address  = $e($d['city'] ?? '') . ', ' . $e($d['pvz'] ?? '');
} else {
    $delivery = 'Курьер до двери';
    $parts = [$e($d['city'] ?? ''), $e($d['street'] ?? ''), 'д. ' . $e($d['house'] ?? '')];
    if (!empty($d['flat']))     $parts[] = 'кв. ' . $e($d['flat']);
    if (!empty($d['entrance'])) $parts[] = 'подъезд ' . $e($d['entrance']);
    if (!empty($d['floor']))    $parts[] = 'этаж ' . $e($d['floor']);
    if (!empty($d['intercom'])) $parts[] = 'домофон ' . $e($d['intercom']);
    $address = implode(', ', $parts);
    if (!empty($d['date'])) {
        $delivery .= ', ' . $e(date('d.m.Y', strtotime($d['date']))) . ' ' . $e($d['slot'] ?? '');
    }
}

$pay = ($o['payment'] ?? '') === 'cod' ? 'При получении' : 'Онлайн (карта / СБП)';

$text  = "🛒 <b>Новый заказ #{$orderId}</b>\n\n";
$text .= "👤 <b>Имя:</b> " . $e($name) . "\n";
$text .= "📞 <b>Телефон:</b> " . $e($phone) . "\n";
$text .= "✉️ <b>Почта:</b> " . ($email !== '' ? $e($email) : '—') . "\n\n";
$text .= "📦 <b>Что купил:</b>\n" . implode("\n", $items) . "\n\n";
if (!empty($o['promo'])) $text .= "🏷 Промокод: " . $e($o['promo']) . " (−" . $rub($o['discount'] ?? 0) . ")\n";
$text .= "🚚 Доставка: " . ((int)($o['shipping'] ?? 0) ? $rub($o['shipping']) : 'бесплатно') . "\n";
$text .= "💰 <b>Итого: " . $rub($o['total'] ?? 0) . "</b>\n";
$text .= "💳 Оплата: {$pay}\n\n";
$text .= "📍 <b>Адрес доставки:</b> {$address}\n";
$text .= "🚛 <b>Способ:</b> {$delivery}\n";
if (!empty($d['comment'])) $text .= "💬 <b>Комментарий:</b> " . $e($d['comment']) . "\n";

$chatId = getChatId();
if (!$chatId) { fail(500, 'Chat ID not found: напишите боту /start и повторите'); }

$res = tg('sendMessage', ['chat_id' => $chatId, 'text' => $text, 'parse_mode' => 'HTML', 'disable_web_page_preview' => true]);
if (empty($res['ok'])) { fail(502, 'Telegram error: ' . ($res['description'] ?? 'unknown')); }

echo json_encode(['ok' => true, 'id' => $orderId]);

// ===== функции =====
function tg(string $method, array $params): array {
    $ch = curl_init('https://api.telegram.org/bot' . BOT_TOKEN . '/' . $method);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $params,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $out = curl_exec($ch);
    curl_close($ch);
    return json_decode((string)$out, true) ?: [];
}

function getChatId(): string {
    if (CHAT_ID !== '') return CHAT_ID;
    $file = __DIR__ . '/chat_id.txt';
    if (is_file($file) && ($id = trim(file_get_contents($file))) !== '') return $id;
    $upd = tg('getUpdates', ['limit' => 100]);
    $id = '';
    foreach (array_reverse($upd['result'] ?? []) as $u) {
        $chat = $u['message']['chat'] ?? $u['my_chat_member']['chat'] ?? null;
        if ($chat && isset($chat['id'])) { $id = (string)$chat['id']; break; }
    }
    if ($id !== '') @file_put_contents($file, $id);
    return $id;
}

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}
