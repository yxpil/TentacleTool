@echo off
rem 编译 find 原生索引器（需要 MinGW-w64 / Strawberry Perl 自带的 gcc）
cd /d %~dp0
set GCC=gcc
if not exist "%GCC%" if exist "C:\Strawberry\c\bin\gcc.exe" set GCC=C:\Strawberry\c\bin\gcc.exe
if not exist "%GCC%" (
  for /f "delims=" %%i in ('where gcc 2^>nul') do set GCC=%%i
)
echo using gcc: %GCC%
"%GCC%" -O2 -Wall -Wextra -s -o findidx.exe findidx.c -lshell32
if %errorlevel%==0 (
  echo OK: findidx.exe built.
) else (
  echo FAILED to build findidx.exe
  exit /b 1
)
