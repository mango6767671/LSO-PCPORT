#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
  #ifdef ONLINE161_BUILD
    #define O161_API __declspec(dllexport)
  #else
    #define O161_API __declspec(dllimport)
  #endif
  #define O161_CALL __cdecl
#else
  #define O161_API
  #define O161_CALL
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef enum O161_Result {
  O161_OK = 0,
  O161_INVALID_ARGUMENT = 1,
  O161_NETWORK_ERROR = 2,
  O161_HTTP_ERROR = 3,
  O161_NOT_AUTHENTICATED = 4,
  O161_PARSE_ERROR = 5
} O161_Result;

// Set the independent ONLINE161 API root, e.g. https://online.example.com.
// The client appends /api/pc/v1. HTTPS certificate validation remains enabled.
O161_API O161_Result O161_CALL O161_Initialize(const wchar_t* server_url);
O161_API O161_Result O161_CALL O161_Register(const char* email, const char* display_name, const char* password);
O161_API O161_Result O161_CALL O161_Login(const char* email, const char* password);
O161_API O161_Result O161_CALL O161_GetProfile(char** response_json);
O161_API O161_Result O161_CALL O161_GetSessions(const char* game_version, const char* region, char** response_json);
O161_API O161_Result O161_CALL O161_Logout();
O161_API const char* O161_CALL O161_GetLastError();
O161_API void O161_CALL O161_Free(void* memory);

#ifdef __cplusplus
}
#endif
