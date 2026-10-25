#define ONLINE161_BUILD
#include "online161.h"
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <mutex>
#include <cstring>
#include <cstdio>

#pragma comment(lib, "winhttp.lib")

namespace {
std::wstring g_server;
std::string g_token;
std::string g_error;
std::mutex g_mutex;

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), (int)value.size(), nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), (int)value.size(), out.data(), n);
  return out;
}
std::string jsonEscape(const std::string& value) {
  std::string out;
  for (unsigned char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char buf[7]; sprintf_s(buf, "\\u%04x", c); out += buf; }
        else out += (char)c;
    }
  }
  return out;
}
std::string jsonString(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return {};
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return {};
  p = json.find('"', p + 1);
  if (p == std::string::npos) return {};
  std::string out;
  for (++p; p < json.size(); ++p) {
    char c = json[p];
    if (c == '"') return out;
    if (c == '\\' && p + 1 < json.size()) {
      char e = json[++p];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        default: return {};
      }
    } else out += c;
  }
  return {};
}
bool splitUrl(const std::wstring& url, std::wstring& host, std::wstring& path, INTERNET_PORT& port, bool& secure) {
  URL_COMPONENTS c{}; c.dwStructSize = sizeof(c);
  c.dwHostNameLength = (DWORD)-1; c.dwUrlPathLength = (DWORD)-1; c.dwExtraInfoLength = (DWORD)-1;
  if (!WinHttpCrackUrl(url.c_str(), 0, 0, &c)) return false;
  secure = c.nScheme == INTERNET_SCHEME_HTTPS;
  if (!secure && c.nScheme != INTERNET_SCHEME_HTTP) return false;
  host.assign(c.lpszHostName, c.dwHostNameLength);
  path.assign(c.lpszUrlPath, c.dwUrlPathLength);
  if (c.dwExtraInfoLength) path.append(c.lpszExtraInfo, c.dwExtraInfoLength);
  port = c.nPort;
  return !host.empty();
}
O161_Result request(const wchar_t* method, const std::wstring& endpoint, const std::string& body, bool auth, std::string& response) {
  std::wstring host, path; INTERNET_PORT port = 0; bool secure = false;
  if (!splitUrl(g_server + endpoint, host, path, port, secure)) { g_error = "Invalid server URL."; return O161_INVALID_ARGUMENT; }
  HINTERNET session = WinHttpOpen(L"ONLINE161/0.1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) { g_error = "WinHttpOpen failed."; return O161_NETWORK_ERROR; }
  HINTERNET connection = WinHttpConnect(session, host.c_str(), port, 0);
  if (!connection) { g_error = "WinHttpConnect failed."; WinHttpCloseHandle(session); return O161_NETWORK_ERROR; }
  DWORD flags = secure ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET req = WinHttpOpenRequest(connection, method, path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!req) { g_error = "WinHttpOpenRequest failed."; WinHttpCloseHandle(connection); WinHttpCloseHandle(session); return O161_NETWORK_ERROR; }
  std::wstring headers = L"Content-Type: application/json\r\nAccept: application/json\r\n";
  if (auth && !g_token.empty()) headers += L"Authorization: Bearer " + widen(g_token) + L"\r\n";
  BOOL ok = WinHttpSendRequest(req, headers.c_str(), (DWORD)-1, body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(), (DWORD)body.size(), (DWORD)body.size(), 0);
  if (ok) ok = WinHttpReceiveResponse(req, nullptr);
  if (!ok) {
    g_error = "HTTP request failed (WinHTTP " + std::to_string(GetLastError()) + ").";
    WinHttpCloseHandle(req); WinHttpCloseHandle(connection); WinHttpCloseHandle(session);
    return O161_NETWORK_ERROR;
  }
  DWORD status = 0, size = sizeof(status);
  WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX);
  for (;;) {
    DWORD available = 0;
    if (!WinHttpQueryDataAvailable(req, &available) || available == 0) break;
    std::vector<char> chunk(available);
    DWORD read = 0;
    if (!WinHttpReadData(req, chunk.data(), available, &read)) break;
    response.append(chunk.data(), read);
  }
  WinHttpCloseHandle(req); WinHttpCloseHandle(connection); WinHttpCloseHandle(session);
  if (status < 200 || status >= 300) {
    g_error = "Server returned HTTP " + std::to_string(status) + ": " + response;
    return O161_HTTP_ERROR;
  }
  g_error.clear();
  return O161_OK;
}
O161_Result authPost(const char* route, const std::string& body) {
  std::string response;
  auto result = request(L"POST", widen(route), body, false, response);
  if (result != O161_OK) return result;
  std::string token = jsonString(response, "token");
  if (token.empty()) { g_error = "Authentication response did not contain a token."; return O161_PARSE_ERROR; }
  g_token = token;
  return O161_OK;
}
O161_Result copyResponse(const std::string& response, char** output) {
  if (!output) return O161_INVALID_ARGUMENT;
  *output = nullptr;
  char* memory = (char*)HeapAlloc(GetProcessHeap(), 0, response.size() + 1);
  if (!memory) { g_error = "Out of memory."; return O161_NETWORK_ERROR; }
  memcpy(memory, response.data(), response.size());
  memory[response.size()] = 0;
  *output = memory;
  return O161_OK;
}
}
extern "C" O161_Result O161_CALL O161_Initialize(const wchar_t* server_url) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!server_url || !*server_url) return O161_INVALID_ARGUMENT;
  g_server = server_url;
  while (!g_server.empty() && g_server.back() == L'/') g_server.pop_back();
  if (g_server.find(L"/api/pc/v1") == std::wstring::npos) g_server += L"/api/pc/v1";
  std::wstring host, path; INTERNET_PORT port; bool secure;
  if (!splitUrl(g_server + L"/status", host, path, port, secure)) { g_error = "Server URL must be a valid HTTP(S) URL."; return O161_INVALID_ARGUMENT; }
  return O161_OK;
}
extern "C" O161_Result O161_CALL O161_Register(const char* email, const char* display_name, const char* password) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!email || !display_name || !password || g_server.empty()) return O161_INVALID_ARGUMENT;
  return authPost("/auth/register", "{\"email\":\""+jsonEscape(email)+"\",\"displayName\":\""+jsonEscape(display_name)+"\",\"password\":\""+jsonEscape(password)+"\"}");
}
extern "C" O161_Result O161_CALL O161_Login(const char* email, const char* password) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!email || !password || g_server.empty()) return O161_INVALID_ARGUMENT;
  return authPost("/auth/login", "{\"email\":\""+jsonEscape(email)+"\",\"password\":\""+jsonEscape(password)+"\"}");
}
extern "C" O161_Result O161_CALL O161_GetProfile(char** response_json) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_token.empty()) return O161_NOT_AUTHENTICATED;
  std::string response; auto r = request(L"GET", L"/auth/me", "", true, response);
  return r == O161_OK ? copyResponse(response, response_json) : r;
}
extern "C" O161_Result O161_CALL O161_GetSessions(const char* game_version, const char* region, char** response_json) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_token.empty()) return O161_NOT_AUTHENTICATED;
  std::string endpoint = "/sessions";
  if (game_version && *game_version) endpoint += "?gameVersion=" + std::string(game_version);
  if (region && *region) endpoint += (endpoint.find('?') == std::string::npos ? "?" : "&") + std::string("region=") + region;
  std::string response; auto r = request(L"GET", widen(endpoint), "", true, response);
  return r == O161_OK ? copyResponse(response, response_json) : r;
}
extern "C" O161_Result O161_CALL O161_Logout() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_token.empty()) return O161_OK;
  std::string response; auto r = request(L"POST", L"/auth/logout", "{}", true, response);
  if (r == O161_OK) g_token.clear();
  return r;
}
extern "C" const char* O161_CALL O161_GetLastError() { return g_error.c_str(); }
extern "C" void O161_CALL O161_Free(void* memory) { if (memory) HeapFree(GetProcessHeap(), 0, memory); }
