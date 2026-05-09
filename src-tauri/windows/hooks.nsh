; UNICREW NSIS installer hooks
; - インストール時にデスクトップショートカットを自動作成
; - アンインストール時にデスクトップショートカットを削除
;
; Tauri 公式: https://tauri.app/distribute/windows-installer/#installer-hooks
; Tauri NSISテンプレートが提供する変数:
;   ${MAINBINARYNAME} - exe ベース名 (例: unicrew)
;   ${PRODUCTNAME}    - 配布名 (例: UNICREW)

!macro NSIS_HOOK_POSTINSTALL
  ; デスクトップにショートカット作成（既存があれば上書き）
  CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; アンインストール開始前にデスクトップショートカット削除
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
