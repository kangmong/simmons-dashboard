@echo off
cd /d "C:\Users\Simmons_\python_project\시몬스 프로젝트\시몬스 해외 매트릭스 업계 동향"
echo 대시보드 서버를 켜는 중입니다...
echo 이 창을 닫으면 서버가 꺼집니다. 켜둔 채로 두세요.
start "" http://localhost:5000
python dashboard_server.py
pause