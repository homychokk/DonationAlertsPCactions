using System;
using System.Runtime.InteropServices;
using System.Threading;

class InvertMouse {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT lpPoint);

    delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    const int WH_MOUSE_LL = 14;
    const int WM_MOUSEMOVE = 0x0200;

    struct POINT {
        public int x;
        public int y;
    }

    struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);

    static IntPtr _hookID = IntPtr.Zero;
    static LowLevelMouseProc _proc = HookCallback;
    
    static int _lastX = 0;
    static int _lastY = 0;
    static bool _initialized = false;
    static int _screenWidth = 0;
    static int _screenHeight = 0;
    static volatile bool _running = true;

    static void Main(string[] args) {
        int durationSec = 5;
        int customSec;
        if (args.Length > 0 && int.TryParse(args[0], out customSec)) {
            durationSec = customSec;
        }

        _screenWidth = GetSystemMetrics(0);
        _screenHeight = GetSystemMetrics(1);

        POINT initPt;
        GetCursorPos(out initPt);
        _lastX = initPt.x;
        _lastY = initPt.y;
        _initialized = true;

        Console.WriteLine("Inverting mouse for " + durationSec + " seconds (low-level hook)...");

        using (System.Diagnostics.Process curProcess = System.Diagnostics.Process.GetCurrentProcess())
        using (System.Diagnostics.ProcessModule curModule = curProcess.MainModule) {
            _hookID = SetWindowsHookEx(WH_MOUSE_LL, _proc, GetModuleHandle(curModule.ModuleName), 0);
        }

        // Start exit timer thread
        Thread timerThread = new Thread(() => {
            Thread.Sleep(durationSec * 1000);
            _running = false;
            UnhookWindowsHookEx(_hookID);
        });
        timerThread.Start();

        // Native non-blocking message loop
        MSG msg;
        while (_running) {
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { // 1 is PM_REMOVE
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            Thread.Sleep(1);
        }

        Console.WriteLine("Mouse inversion stopped.");
    }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam == (IntPtr)WM_MOUSEMOVE && _running) {
            MSLLHOOKSTRUCT hookStruct = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));

            // Check if this is an injected movement (flags & 1 or 2)
            bool isInjected = (hookStruct.flags & 1) != 0 || (hookStruct.flags & 2) != 0;

            if (!isInjected && _initialized) {
                int dx = hookStruct.pt.x - _lastX;
                int dy = hookStruct.pt.y - _lastY;

                if (dx != 0 || dy != 0) {
                    int targetX = _lastX - dx;
                    int targetY = _lastY - dy;

                    targetX = Math.Max(0, Math.Min(_screenWidth - 1, targetX));
                    targetY = Math.Max(0, Math.Min(_screenHeight - 1, targetY));

                    _lastX = targetX;
                    _lastY = targetY;

                    SetCursorPos(targetX, targetY);

                    // Suppress original message
                    return (IntPtr)1;
                }
            } else {
                _lastX = hookStruct.pt.x;
                _lastY = hookStruct.pt.y;
            }
        }
        return CallNextHookEx(_hookID, nCode, wParam, lParam);
    }
}
