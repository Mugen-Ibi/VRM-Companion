// A deliberately narrow Windows file adapter. No shell, delete or overwrite operation.
// Build with the Windows .NET Framework compiler (no separate SDK required).
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class Program {
    const uint READ = 0x80000000, DELETE = 0x10000, ATTR = 0x80;
    const uint OPEN = 3, BACKUP = 0x02000000, REPARSE = 0x00200000;
    const uint BAD = 0x400 | 0x1000 | 0x40000 | 0x400000;
    const long MAX_FILE = 512L * 1024 * 1024;
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
    static HashSet<string> Categories = new HashSet<string>(new [] { "画像", "文書", "動画", "音声", "圧縮ファイル", "その他" }, StringComparer.Ordinal);
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attr, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path, IntPtr security);
    static string S(Dictionary<string,object> o, string key) { object v; return o.TryGetValue(key,out v) && v != null ? Convert.ToString(v) : ""; }
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static Exception Win() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Id(Info i) { return i.Volume.ToString("X8") + ":" + i.IndexHigh.ToString("X8") + i.IndexLow.ToString("X8"); }
    static long Size(Info i) { return ((long)i.SizeHigh << 32) | i.SizeLow; }
    static string Modified(Info i) { return (((long)i.WriteHigh << 32) | i.WriteLow).ToString(); }
    static Info Get(SafeFileHandle h) { Info i; if (!GetFileInformationByHandle(h,out i)) throw Win(); return i; }
    static SafeFileHandle Open(string p, uint access, uint share) {
        SafeFileHandle h = CreateFile("\\\\?\\" + p, access, share, IntPtr.Zero, OPEN, BACKUP | REPARSE, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw Win(); }
        return h;
    }
    static bool Within(string p, string parent) { return p.Equals(parent, StringComparison.OrdinalIgnoreCase) || p.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
    static void Segment(string p) {
        if (String.IsNullOrEmpty(p) || p == "." || p == ".." || p.EndsWith(".") || p.EndsWith(" ") || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new Exception("無効なファイル名です。");
        string stem = p.Split('.')[0].ToUpperInvariant();
        if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || System.Text.RegularExpressions.Regex.IsMatch(stem, "^(COM|LPT)[1-9]$")) throw new Exception("予約名は扱えません。");
    }
    static string RootPath(string input) {
        if (input.Length < 4 || !Char.IsLetter(input[0]) || input[1] != ':' || input[2] != '\\' || input.StartsWith("\\\\")) throw new Exception("ローカルフォルダを選択してください。");
        string p = Path.GetFullPath(input).TrimEnd('\\');
        foreach (string part in p.Substring(3).Split('\\')) Segment(part);
        DriveInfo drive = new DriveInfo(p.Substring(0,3));
        if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS") throw new Exception("ローカルNTFSフォルダのみ対応しています。");
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (p.Equals(user,StringComparison.OrdinalIgnoreCase)) throw new Exception("ユーザーフォルダ全体は選択できません。");
        string[] protectedPaths = { Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), Environment.GetEnvironmentVariable("OneDrive"), Environment.GetEnvironmentVariable("OneDriveConsumer"), Environment.GetEnvironmentVariable("OneDriveCommercial") };
        foreach (string q in protectedPaths) if (!String.IsNullOrEmpty(q) && Within(p,q)) throw new Exception("システム・アプリ管理領域または同期フォルダは対象外です。");
        return p;
    }
    class Pins : IDisposable {
        public List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        public string Root; public string Identity;
        public Pins(string root, string expected) {
            Root = RootPath(root);
            try {
                string p = Root.Substring(0,3);
                Pin(p, false);
                foreach (string part in Root.Substring(3).Split('\\')) { p = Path.Combine(p,part); Pin(p, p == Root); }
                Identity = Id(Get(Handles[Handles.Count-1]));
                if (expected.Length > 0 && expected != Identity) throw new Exception("対象フォルダが変更されています。選択し直してください。");
            } catch { Dispose(); throw; }
        }
        public void Pin(string p, bool checkHidden) {
            // Denying FILE_SHARE_DELETE pins this directory against rename/replacement.
            SafeFileHandle h = Open(p,ATTR,1);
            Handles.Add(h); Info i = Get(h);
            if ((i.Attr & 16) == 0 || (i.Attr & BAD) != 0 || (checkHidden && (i.Attr & 6) != 0)) throw new Exception("リンク・同期・非通常フォルダは対象外です。");
        }
        public void Dispose() { for (int n=Handles.Count-1;n>=0;n--) Handles[n].Dispose(); Handles.Clear(); }
    }
    static string Relative(string root, string rel) {
        string[] parts = rel.Split('/');
        if (parts.Length < 1 || parts.Length > 2) throw new Exception("直下ファイルだけが対象です。");
        foreach (string p in parts) Segment(p);
        if (parts.Length == 2 && !Categories.Contains(parts[0])) throw new Exception("分類フォルダ以外は対象外です。");
        return Path.Combine(root, rel.Replace('/','\\'));
    }
    static Info Regular(SafeFileHandle h, bool enforceSize) {
        Info i = Get(h);
        if ((i.Attr & (BAD | 16 | 6)) != 0 || i.Links != 1) throw new Exception("リンク・隠し・システムファイルは対象外です。");
        if (enforceSize && Size(i) > MAX_FILE) throw new Exception("1ファイル512MiBの上限を超えています。");
        return i;
    }
    static long ReadLimit(Dictionary<string,object> r) {
        if (!r.ContainsKey("maxBytes")) return MAX_FILE;
        long limit;
        if (!Int64.TryParse(S(r,"maxBytes"),out limit) || limit < 0 || limit > MAX_FILE) throw new Exception("読取り予算が不正です。");
        return limit;
    }
    static Dictionary<string,object> Fingerprint(SafeFileHandle h, bool hash, long maxBytes) {
        Info i = Regular(h,hash); string digest = null;
        if (hash) {
            if (Size(i) > maxBytes) throw new Exception("事前確認後にファイルが増大し、読取り予算を超えました。");
            using (SHA256 sha = SHA256.Create()) {
                // Non-owning duplicate wrapper: the original handle stays open for rename.
                using (var stream = new FileStream(new SafeFileHandle(h.DangerousGetHandle(),false), FileAccess.Read,65536,false)) {
                    byte[] buf = new byte[1024*1024]; int n; long done=0, last=0;
                    while (done < maxBytes && (n=stream.Read(buf,0,(int)Math.Min(buf.Length,maxBytes-done))) > 0) {
                        done += n;
                        sha.TransformBlock(buf,0,n,null,0);
                        if (done-last >= 8*1024*1024) { Emit(new { progress=true, done=done, total=Size(i) }); last=done; }
                    }
                    if (done != stream.Length) throw new Exception("読取り中にファイルサイズが変わりました。");
                    sha.TransformFinalBlock(new byte[0],0,0); digest = BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();
                }
            }
        }
        return new Dictionary<string,object> { {"id",Id(i)}, {"size",Size(i)}, {"modified",Modified(i)}, {"hash",digest} };
    }
    static void Check(Dictionary<string,object> actual, object expected) {
        var e = expected as Dictionary<string,object>;
        if (e == null || S(e,"hash").Length != 64 || S(actual,"id") != S(e,"id") || S(actual,"size") != S(e,"size") || S(actual,"modified") != S(e,"modified") || S(actual,"hash") != S(e,"hash")) throw new Exception("ファイルが承認時の状態と一致しません。");
    }
    static object Run(Dictionary<string,object> r) {
        string command = S(r,"command");
        using (var pins = new Pins(S(r,"root"),S(r,"rootIdentity"))) {
            if (command == "root") return new { path=pins.Root, identity=pins.Identity };
            if (S(r,"rootIdentity") == "") throw new Exception("フォルダ識別情報が必要です。");
            if (command == "scan") {
                var entries = new List<object>(); int count=0;
                foreach (string p in Directory.EnumerateFileSystemEntries(pins.Root)) {
                    if (++count > 10000) throw new Exception("走査上限1万件です。対象を絞ってください。");
                    string name = Path.GetFileName(p);
                    try {
                        Segment(name);
                        using (var h = Open(p, ATTR, 7)) {
                            Info i=Get(h);
                            string excluded = (i.Attr & 16) != 0 ? "サブフォルダは走査しません" : (i.Attr & (BAD|6)) != 0 || i.Links != 1 ? "リンク・隠し・システムファイル" : "";
                            entries.Add(new { name=name, size=Size(i), identity=new { id=Id(i), size=Size(i), modified=Modified(i) }, excluded=excluded });
                        }
                    } catch { entries.Add(new { name=name, size=0, excluded="読み取り不可または非対応の名前" }); }
                }
                return entries;
            }
            string from = S(r,"from"), to = S(r,"to");
            if (command == "mkdir") {
                if(!Categories.Contains(to)) throw new Exception("無効な分類先です。");
                string target = Path.Combine(pins.Root,to);
                if (!CreateDirectory("\\\\?\\"+target,IntPtr.Zero)) throw Win();
                pins.Pin(target,true);
                return new { created=true, identity=Id(Get(pins.Handles[pins.Handles.Count-1])) };
            }
            if(command == "directory") {
                if(!Categories.Contains(to)) throw new Exception("無効な分類先です。");
                pins.Pin(Path.Combine(pins.Root,to),true);
                return new { identity=Id(Get(pins.Handles[pins.Handles.Count-1])) };
            }
            string source = Relative(pins.Root,from);
            if(from.Contains("/")) pins.Pin(Path.GetDirectoryName(source),true);
            if(command == "stat") {
                using(var h = Open(source, ATTR, 1)) return Fingerprint(h,false,0);
            }
            if(command == "inspect") {
                using(var h = Open(source, READ, 1)) return Fingerprint(h,true,ReadLimit(r));
            }
            if(command != "move") throw new Exception("非対応の操作です。");
            string dest = Relative(pins.Root,to);
            if(from.Contains("/") == to.Contains("/") || Path.GetFileName(source) != Path.GetFileName(dest)) throw new Exception("分類移動・復元以外は実行できません。");
            if(to.Contains("/")) pins.Pin(Path.GetDirectoryName(dest),true);
            using(var h=Open(source,READ|DELETE,1)) {
                var identity=Fingerprint(h,true,ReadLimit(r)); Check(identity,r["expected"]);
                // FILE_RENAME_INFO, x64: flags at 0, root handle at 8, length at 16, UTF16 name at 20.
                byte[] name=Encoding.Unicode.GetBytes(dest); int length=20+name.Length+2;
                IntPtr buffer=Marshal.AllocHGlobal(length);
                try {
                    Marshal.Copy(new byte[length],0,buffer,length);
                    Marshal.WriteInt32(buffer,0,0); // ReplaceIfExists = FALSE, enforced by the kernel.
                    Marshal.WriteIntPtr(buffer,8,IntPtr.Zero);
                    Marshal.WriteInt32(buffer,16,name.Length);
                    Marshal.Copy(name,0,IntPtr.Add(buffer,20),name.Length);
                    if(!SetFileInformationByHandle(h,3,buffer,(uint)length)) throw Win();
                    return identity;
                } finally { Marshal.FreeHGlobal(buffer); }
            }
        }
    }
    static int Main() {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        try {
            string line=Console.ReadLine(); if(line==null || line.Length>100000) throw new Exception("入力が不正です。");
            var request=Json.Deserialize<Dictionary<string,object>>(line);
            Emit(new { ok=true, value=Run(request) }); return 0;
        } catch(Exception ex) { Emit(new { ok=false, error=ex.Message }); return 1; }
    }
}
