# GAIN — Audio Boost

Ứng dụng web thuần HTML / CSS / JS giúp tải file **MP3** hoặc **M4A**, chọn mức khuếch đại **1.5× · 2× · 3× · 4× · 5×**, rồi phát ngay trên trình duyệt (Web Audio API).

## Chạy local

Mở `index.html` bằng trình duyệt, hoặc dùng server tĩnh:

```bash
python3 -m http.server 8080
```

Sau đó vào `http://localhost:8080`.

## Tính năng

- Mobile-first, xử lý hoàn toàn trên client
- Khuếch đại qua `GainNode` (Web Audio API)
- Visualizer tần số khi đang phát
- Kéo thanh tiến trình để tua
