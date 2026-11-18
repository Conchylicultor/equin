set -e
export XDG_RUNTIME_DIR=/run/user/$(id -u)
mkdir -p ~/exp ~/.config/systemd/user
cat > ~/exp/main.sh <<'M'
#!/bin/bash
trap 'echo main-got-SIGTERM >> ~/exp/log; exit 0' TERM
while [ ! -f ~/exp/go ]; do sleep 1; done
python3 -c 'x=[]
while True: x.append(bytearray(50*1024*1024))' &
sleep 1000 & wait
M
chmod +x ~/exp/main.sh; rm -f ~/exp/go; : > ~/exp/log
unit() { cat > ~/.config/systemd/user/exp.service <<U
[Service]
Type=simple
ExecStart=/home/admin/exp/main.sh
Restart=on-failure
RestartSec=10
KillMode=process
MemoryMax=300M
$1
U
}
unit ""
systemctl --user daemon-reload; systemctl --user start exp.service; sleep 2
echo "before: $(systemctl --user show exp.service -p OOMPolicy -p MainPID)"
unit "OOMPolicy=continue"
systemctl --user daemon-reload
echo "after reload: $(systemctl --user show exp.service -p OOMPolicy -p MainPID)"
touch ~/exp/go; sleep 8
systemctl --user show exp.service -p ActiveState -p SubState -p Result -p MainPID
cat ~/exp/log
journalctl --user -u exp.service --no-pager -n 5 -o cat
