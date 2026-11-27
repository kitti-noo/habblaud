# ติดตั้งบนเครื่องใหม่ (Docker + สั่ง agent จากหน้าเว็บ)

คู่มือนี้พาตั้งค่า Habblaud บนเครื่องใหม่ให้ใช้ได้ครบ: สร้าง agent จากหน้าเว็บ, เลือกโปรเจกต์ด้วยการ browse
โฟลเดอร์, ปุ่ม **+** ของแต่ละโปรเจกต์, พิมพ์สั่งงานและแนบรูปหรือไฟล์ส่งให้ agent, และดูการทำงานแบบ real-time
โดยรัน Habblaud ใน Docker

> สำหรับ macOS เป็นหลัก ส่วน Linux ใช้ขั้นตอนเดียวกันได้ ยกเว้นส่วน "เปิด bridge อัตโนมัติ" (launchd)
> รายละเอียดอื่นๆ ทั้งหมดอยู่ใน [README.md](README.md)

## สิ่งที่ต้องมีก่อน

- **Node.js 22.12 ขึ้นไป** และ npm (`node -v`)
- **Docker** (Docker Desktop บน Mac)
- **Claude Code** ติดตั้งและ login แล้ว (`claude --version`)
- (ถ้าใช้) **Codex** ติดตั้งและ login แล้ว (`codex --version`)

## ติดตั้ง

```sh
git clone https://github.com/kitti-noo/habblaud.git
cd habblaud
npm install
```

### 1. เปิดฟีเจอร์สั่ง agent จากหน้าเว็บ

สร้างไฟล์ `.env` ในโฟลเดอร์ `habblaud`:

```sh
echo "HABBLAUD_PTY=1" >> .env
```

ถ้าไม่ตั้งค่านี้ ปุ่ม **New agent**, **📁 Browse folders…** และปุ่ม **+** ที่หัวโปรเจกต์จะไม่ขึ้น ไฟล์ `.env`
ไม่ได้อยู่ใน git จึงต้องสร้างใหม่ทุกเครื่อง ภาษาของหน้าเว็บตั้งในไฟล์เดียวกันได้ เช่น `HABBLAUD_LANG=en`

### 2. ติดตั้ง plugin ของ Claude Code

```sh
npm run mod:install
```

plugin นี้ทำให้ส่งข้อความหา agent จากหน้าเว็บได้ ตอบคำขอ permission จากหน้าเว็บได้ และแสดงการใช้งาน (usage)
ถ้ามีหลายบัญชี Claude Code คำสั่งนี้จะติดตั้งให้ทุกบัญชี เช็กผลได้ด้วย `npm run mod:status`

Session ของ Claude Code ที่เปิดอยู่ก่อนติดตั้งจะยังไม่โหลด plugin ต้องเปิด session ใหม่ หรือพิมพ์
`/reload-plugins` ใน session นั้น

Claude Code โหลด plugin จากโฟลเดอร์ `habblaud/mod/` โดยตรง ถ้าย้ายหรือลบโฟลเดอร์ `habblaud` plugin จะหายไปด้วย
ย้ายแล้วให้รัน `npm run mod:install` ใหม่จากที่ใหม่

### 3. รัน Habblaud ใน Docker

```sh
npm run docker:up
```

สคริปต์จะหาบัญชี Claude Code และ Codex บนเครื่อง สร้าง `docker-compose.override.yml` (mount เฉพาะ transcript
แบบอ่านอย่างเดียว) แล้ว build และรัน container จากนั้นเปิด <http://localhost:4747>

- ดู log: `npm run docker:logs`
- หยุด: `npm run docker:down`

### 4. เปิด bridge ไว้บนเครื่อง

```sh
npm run codex:bridge
```

container มองไม่เห็นโฟลเดอร์ของเครื่องและรัน `claude` เองไม่ได้ ตัว bridge ทำงานแทนบนเครื่องจริง:

- สร้าง agent ใหม่ (`claude --bg`)
- อ่านรายชื่อโฟลเดอร์ให้ปุ่ม Browse folders
- บันทึกไฟล์แนบลง `~/.habblaud/attachments/`
- ส่งข้อความให้ Codex และถอดเสียงพูด (ถ้าติดตั้ง Whisper ไว้)

ต้องเปิด bridge ค้างไว้ตลอดที่ใช้งาน ถ้าปิด หน้าเว็บจะขึ้นข้อความว่า
`the computer helper (npm run codex:bridge) isn't running` ถ้าไม่อยากเปิดเองทุกครั้ง ดูหัวข้อ
[เปิด bridge อัตโนมัติ](#เปิด-bridge-อัตโนมัติ-macos)

### 5. ให้ Claude Code trust โฟลเดอร์โปรเจกต์

Agent ที่สร้างจากหน้าเว็บจะรันในเบื้องหลังได้เฉพาะในโฟลเดอร์ที่ Claude Code trust แล้วเท่านั้น สำหรับโปรเจกต์ใหม่
ให้รันครั้งแรกแบบนี้แล้วกดยอมรับ:

```sh
cd /path/to/project
claude
```

ถ้าโฟลเดอร์ยังไม่ได้ trust ระบบจะเปิดแอป Claude พร้อมคำขอที่กรอกไว้ ต้องไปกด Enter ในแอปเอง

## ใช้งาน

| อยากทำ | ทำที่ไหน |
|---|---|
| สร้าง agent ใหม่ | ปุ่ม **New agent** บนแถบด้านบน หรือปุ่ม **+** ที่หัวโปรเจกต์ในแถบซ้าย |
| เลือกโปรเจกต์ | เลือกจากรายการล่าสุด, **+ Other folder** (พิมพ์ path) หรือ **📁 Browse folders…** |
| สั่งงาน agent ที่รันอยู่ | กดที่ agent แล้วพิมพ์ในช่องข้อความ (Enter = ส่ง, Shift+Enter = ขึ้นบรรทัดใหม่) |
| แนบรูปหรือไฟล์ | ปุ่มคลิปหนีบกระดาษ, วางด้วย Cmd+V (เช่น screenshot) หรือลากไฟล์มาวาง |
| ดูการทำงาน | กดที่ agent เพื่อดู terminal, แถบ **Activity** ด้านล่าง, ภาพรวมแต่ละโปรเจกต์ในแถบซ้าย |
| ตอบคำขอ permission | ขึ้นเป็นการ์ดในหน้าเว็บ ตอบได้เลยไม่ต้องกลับไปที่ terminal |

ไฟล์แนบถูกบันทึกไว้ที่ `~/.habblaud/attachments/` และ agent ได้รับ path ของไฟล์ต่อท้ายข้อความ ไฟล์เก่าไม่ถูกลบ
อัตโนมัติ ลบเองได้เมื่อไม่ใช้แล้ว

## เปิด bridge อัตโนมัติ (macOS)

ให้ macOS เปิด `npm run codex:bridge` เองตอน login และเปิดใหม่ถ้าล่ม รันคำสั่งนี้ในโฟลเดอร์ `habblaud`:

```sh
mkdir -p ~/.habblaud ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.habblaud.bridge.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.habblaud.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$(which npm)</string><string>run</string><string>codex:bridge</string></array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.habblaud/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.habblaud/bridge.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.habblaud.bridge.plist
```

ไฟล์นี้บันทึก path ของโฟลเดอร์ `habblaud`, `npm` และ `PATH` ตอนที่รัน (`claude` กับ `codex` ต้องอยู่ใน
`PATH` ตอนนั้น) ถ้าย้ายโฟลเดอร์ ให้เลิกใช้ก่อนแล้วรันใหม่

- เช็กสถานะ: `launchctl print gui/$(id -u)/com.habblaud.bridge | grep state`
- ดู log: `tail -f ~/.habblaud/bridge.log`
- เลิกใช้: `launchctl bootout gui/$(id -u)/com.habblaud.bridge && rm ~/Library/LaunchAgents/com.habblaud.bridge.plist`

## อัปเดตเป็นเวอร์ชันใหม่

```sh
git pull
npm install
npm run docker:up
```

ถ้าเปิด bridge ไว้เอง ให้ปิด (Ctrl+C) แล้วเปิดใหม่ ถ้าใช้ launchd:
`launchctl kickstart -k gui/$(id -u)/com.habblaud.bridge`

## แก้ปัญหา

| อาการ | สาเหตุและวิธีแก้ |
|---|---|
| ไม่มีปุ่ม New agent หรือปุ่ม **+** | `.env` ยังไม่มี `HABBLAUD_PTY=1` หรือยังไม่ได้รัน `npm run docker:up` หลังแก้ `.env` และต้องเปิดหน้าเว็บผ่าน `http://localhost:4747` เท่านั้น |
| `the computer helper (npm run codex:bridge) isn't running` | ยังไม่ได้เปิด bridge (ขั้นตอนที่ 4) |
| ช่องส่งข้อความบอกว่า session ไม่ได้ต่อ plugin | รัน `npm run mod:install` แล้วเปิด session ของ Claude Code ใหม่ |
| สร้าง agent แล้วไปเปิดในแอป Claude แทน | โฟลเดอร์ยังไม่ได้ trust (ขั้นตอนที่ 5) |
| Agent ใหม่ไม่ขึ้นในออฟฟิศ | รอสักครู่ หรือเช็ก log ของ bridge ว่ามี error ไหม |
