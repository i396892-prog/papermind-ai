@echo off
chcp 65001 >nul
title PaperMind AI
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
