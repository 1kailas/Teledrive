using System;
using System.Collections.Generic;
using System.Linq;

namespace TeleDrive_WinUI.Models;

public class FolderPickerOption
{
    public string? Id { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public string RawName { get; set; } = string.Empty;
    public int Level { get; set; }

    public override string ToString() => DisplayName;

    public static List<FolderPickerOption> BuildFlattenedFolderList(
        IEnumerable<FolderModel>? folders,
        string rootName = "📁 My Drive (Root)")
    {
        var result = new List<FolderPickerOption>
        {
            new FolderPickerOption
            {
                Id = null,
                DisplayName = rootName,
                RawName = "My Drive",
                Level = 0
            }
        };

        if (folders == null) return result;

        var folderList = folders.Where(f => !string.IsNullOrWhiteSpace(f.Id)).ToList();
        var idMap = folderList.ToDictionary(f => f.Id, f => f, StringComparer.OrdinalIgnoreCase);

        // Group children by parentId using "" as sentinel for root/null
        var childrenByParent = new Dictionary<string, List<FolderModel>>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in folderList)
        {
            string pid = string.IsNullOrWhiteSpace(f.ParentId) ? "" : f.ParentId!;
            // If parentId references an unknown or non-existent folder, treat as root-level
            if (!string.IsNullOrEmpty(pid) && !idMap.ContainsKey(pid))
            {
                pid = "";
            }

            if (!childrenByParent.TryGetValue(pid, out var list))
            {
                list = new List<FolderModel>();
                childrenByParent[pid] = list;
            }
            list.Add(f);
        }

        // Sort children alphabetically by name
        foreach (var list in childrenByParent.Values)
        {
            list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase));
        }

        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Traverse(string parentId, int level)
        {
            if (!childrenByParent.TryGetValue(parentId, out var children)) return;

            foreach (var child in children)
            {
                if (!visited.Add(child.Id)) continue; // avoid cycles

                string indent = new string(' ', level * 4);
                result.Add(new FolderPickerOption
                {
                    Id = child.Id,
                    DisplayName = $"{indent}📁 {child.Name}",
                    RawName = child.Name,
                    Level = level
                });

                Traverse(child.Id, level + 1);
            }
        }

        Traverse("", 1);
        return result;
    }
}
