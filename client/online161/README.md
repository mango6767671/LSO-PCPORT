# ONLINE161 native client DLL

A standalone Windows C++ client library for the independent LSO-PCPORT API. It does not patch the game, load into the GTA process, imitate Rockstar endpoints, or change Rockstar authentication/licensing. A game integration you own or are authorized to modify can call this library.

## Build (Windows, Visual Studio 2022)

```powershell
cmake -S client/online161 -B build/online161 -A x64
cmake --build build/online161 --config Release
```

Output: `build/online161/Release/ONLINE161.dll` (or the generator's equivalent output directory).

## C API

Include `online161.h`, link the import library, and distribute `ONLINE161.dll` beside the integrating application.

1. `O161_Initialize(L"https://your-host.example")`
2. `O161_Login(email, password)` or `O161_Register(email, displayName, password)`
3. `O161_GetProfile(&json)`; release returned memory with `O161_Free(json)`
4. `O161_GetSessions("1.61", "auto", &json)`
5. `O161_Logout()`

The library uses WinHTTP and the operating system's normal TLS certificate validation. The API root is appended with `/api/pc/v1`. Use HTTPS outside localhost. Passwords are sent only to the configured independent API over that connection; the library keeps the bearer token in process memory and never writes it to disk.

## Current capability boundary

This first DLL build implements registration, login, profile retrieval, session-directory listing, and logout. The server currently implements session listing/metadata, not gameplay packet transport. Friends, rich presence, cloud saves, invitations, and real-time game networking remain separate API/client milestones. This DLL is not a drop-in Social Club binary and does not establish compatibility with an unmodified GTA V 1.61 executable.
