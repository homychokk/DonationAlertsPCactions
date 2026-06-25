using System;
using System.Runtime.InteropServices;
using System.Threading;

class SetMouseSpeed {
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfo", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

    [DllImport("user32.dll", EntryPoint = "SystemParametersInfo", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SystemParametersInfo(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);

    const uint SPI_GETMOUSE = 0x0003;
    const uint SPI_SETMOUSE = 0x0004;
    const uint SPI_GETMOUSESPEED = 0x0070;
    const uint SPI_SETMOUSESPEED = 0x0071;
    const uint SPIF_UPDATEINIFILE = 0x01;
    const uint SPIF_SENDCHANGE = 0x02;

    static void Main(string[] args) {
        int durationSec = 5;
        int customSec;
        if (args.Length > 0 && int.TryParse(args[0], out customSec)) {
            durationSec = customSec;
        }

        int targetSpeed = 20; // Default to maximum speed
        int customSpeed;
        if (args.Length > 1 && int.TryParse(args[1], out customSpeed)) {
            targetSpeed = customSpeed;
        }

        // Get current mouse speed
        int originalSpeed = 10;
        IntPtr ptr = Marshal.AllocHGlobal(sizeof(int));
        try {
            if (SystemParametersInfo(SPI_GETMOUSESPEED, 0, ptr, 0)) {
                originalSpeed = Marshal.ReadInt32(ptr);
            }
        } finally {
            Marshal.FreeHGlobal(ptr);
        }

        // Get current acceleration parameters
        int[] originalParams = new int[3];
        bool gotParams = SystemParametersInfo(SPI_GETMOUSE, 0, originalParams, 0);

        Console.WriteLine("Original mouse speed: " + originalSpeed);
        if (gotParams) {
            Console.WriteLine("Original mouse acceleration params: Threshold1=" + originalParams[0] + ", Threshold2=" + originalParams[1] + ", Accelerate=" + originalParams[2]);
        }
        Console.WriteLine("Setting mouse speed to: " + targetSpeed + " and accelerating for " + durationSec + " seconds...");

        // Set new speed (value cast to IntPtr directly)
        SystemParametersInfo(SPI_SETMOUSESPEED, 0, (IntPtr)targetSpeed, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);

        // Enable extremely sensitive mouse acceleration
        // Thresholds are set to 1 and 1, and acceleration flag is set to 2 (which is double acceleration!)
        if (gotParams) {
            int[] fastParams = new int[3];
            fastParams[0] = 1;
            fastParams[1] = 1;
            fastParams[2] = 2; // high acceleration multiplier
            SystemParametersInfo(SPI_SETMOUSE, 0, fastParams, SPIF_SENDCHANGE);
        }

        Thread.Sleep(durationSec * 1000);

        // Restore original speed
        SystemParametersInfo(SPI_SETMOUSESPEED, 0, (IntPtr)originalSpeed, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);

        // Restore original acceleration params
        if (gotParams) {
            SystemParametersInfo(SPI_SETMOUSE, 0, originalParams, SPIF_SENDCHANGE);
            Console.WriteLine("Restored mouse acceleration parameters.");
        }
        Console.WriteLine("Restored mouse speed to: " + originalSpeed);
    }
}
