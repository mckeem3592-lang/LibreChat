using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;

public static class NativeHostLauncher
{
    public static int Main(string[] args)
    {
        var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var node = File.ReadAllText(Path.Combine(directory, "node-path.txt")).Trim();
        var host = Path.Combine(directory, "native-browser-host.js");
        var start = new ProcessStartInfo(node, "\"" + host + "\"") {
            WorkingDirectory = directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true
        };
        using (var child = Process.Start(start)) {
            var inbound = Task.Run(() => {
                try {
                    Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream);
                    child.StandardInput.Close();
                } catch (IOException) { }
            });
            try {
                child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
                child.WaitForExit();
                return child.ExitCode;
            } catch (IOException) {
                if (!child.HasExited) child.Kill();
                return 1;
            }
        }
    }
}
