using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace TeleDrive.Tests;

public class FolderModelDummy
{
    public string Id { get; set; } = string.Empty;
    public string? ParentId { get; set; }
    public string Name { get; set; } = string.Empty;
}

public class FolderPickerOptionTester
{
    public string? Id { get; set; }
    public string? ParentId { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public string RawName { get; set; } = string.Empty;
    public string FullPath { get; set; } = string.Empty;
    public int Level { get; set; }

    public static List<FolderPickerOptionTester> BuildFlattenedFolderList(
        IEnumerable<FolderModelDummy>? folders,
        string rootName = "📁 My Drive (Root)")
    {
        var result = new List<FolderPickerOptionTester>
        {
            new FolderPickerOptionTester
            {
                Id = null,
                ParentId = null,
                DisplayName = rootName,
                RawName = "My Drive",
                FullPath = "My Drive",
                Level = 0
            }
        };

        if (folders == null) return result;

        var folderList = folders.Where(f => !string.IsNullOrWhiteSpace(f.Id)).ToList();
        var idMap = folderList.ToDictionary(f => f.Id, f => f, StringComparer.OrdinalIgnoreCase);

        var childrenByParent = new Dictionary<string, List<FolderModelDummy>>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in folderList)
        {
            string pid = string.IsNullOrWhiteSpace(f.ParentId) ? "" : f.ParentId!;
            if (!string.IsNullOrEmpty(pid) && !idMap.ContainsKey(pid))
            {
                pid = "";
            }

            if (!childrenByParent.TryGetValue(pid, out var list))
            {
                list = new List<FolderModelDummy>();
                childrenByParent[pid] = list;
            }
            list.Add(f);
        }

        foreach (var list in childrenByParent.Values)
        {
            list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase));
        }

        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Traverse(string parentId, int level, string parentPath)
        {
            if (!childrenByParent.TryGetValue(parentId, out var children)) return;

            foreach (var child in children)
            {
                if (!visited.Add(child.Id)) continue;

                string indent = new string(' ', level * 4);
                string currentPath = $"{parentPath} > {child.Name}";
                result.Add(new FolderPickerOptionTester
                {
                    Id = child.Id,
                    ParentId = string.IsNullOrEmpty(parentId) ? null : parentId,
                    DisplayName = $"{indent}📁 {child.Name}",
                    RawName = child.Name,
                    FullPath = currentPath,
                    Level = level
                });

                Traverse(child.Id, level + 1, currentPath);
            }
        }

        Traverse("", 1, "My Drive");
        return result;
    }
}

public class FolderPickerOptionTests
{
    [Fact]
    public void BuildFlattenedFolderList_NullOrEmpty_ReturnsOnlyRoot()
    {
        var optionsNull = FolderPickerOptionTester.BuildFlattenedFolderList(null);
        Assert.Single(optionsNull);
        Assert.Null(optionsNull[0].Id);
        Assert.Equal("📁 My Drive (Root)", optionsNull[0].DisplayName);
        Assert.Equal("My Drive", optionsNull[0].FullPath);
        Assert.Equal(0, optionsNull[0].Level);

        var optionsEmpty = FolderPickerOptionTester.BuildFlattenedFolderList(new List<FolderModelDummy>());
        Assert.Single(optionsEmpty);
        Assert.Null(optionsEmpty[0].Id);
    }

    [Fact]
    public void BuildFlattenedFolderList_FlatFolders_SortedAlphabetically()
    {
        var folders = new List<FolderModelDummy>
        {
            new FolderModelDummy { Id = "f1", Name = "Videos", ParentId = null },
            new FolderModelDummy { Id = "f2", Name = "Documents", ParentId = null },
            new FolderModelDummy { Id = "f3", Name = "Photos", ParentId = null },
        };

        var options = FolderPickerOptionTester.BuildFlattenedFolderList(folders);

        Assert.Equal(4, options.Count);
        Assert.Null(options[0].Id);
        Assert.Equal("f2", options[1].Id); // Documents
        Assert.Equal("    📁 Documents", options[1].DisplayName);
        Assert.Equal("My Drive > Documents", options[1].FullPath);
        Assert.Null(options[1].ParentId);
        Assert.Equal(1, options[1].Level);

        Assert.Equal("f3", options[2].Id); // Photos
        Assert.Equal("    📁 Photos", options[2].DisplayName);
        Assert.Equal("My Drive > Photos", options[2].FullPath);

        Assert.Equal("f1", options[3].Id); // Videos
        Assert.Equal("    📁 Videos", options[3].DisplayName);
        Assert.Equal("My Drive > Videos", options[3].FullPath);
    }

    [Fact]
    public void BuildFlattenedFolderList_MultiLevelHierarchy_IndentsAndBuildsFullPath()
    {
        var folders = new List<FolderModelDummy>
        {
            new FolderModelDummy { Id = "doc", Name = "Documents", ParentId = null },
            new FolderModelDummy { Id = "work", Name = "Work", ParentId = "doc" },
            new FolderModelDummy { Id = "inv", Name = "Invoices", ParentId = "work" },
            new FolderModelDummy { Id = "pic", Name = "Pictures", ParentId = null },
        };

        var options = FolderPickerOptionTester.BuildFlattenedFolderList(folders);

        Assert.Equal(5, options.Count);
        Assert.Equal(0, options[0].Level); // Root

        Assert.Equal("doc", options[1].Id);
        Assert.Equal(1, options[1].Level);
        Assert.Equal("    📁 Documents", options[1].DisplayName);
        Assert.Equal("My Drive > Documents", options[1].FullPath);

        Assert.Equal("work", options[2].Id);
        Assert.Equal(2, options[2].Level);
        Assert.Equal("doc", options[2].ParentId);
        Assert.Equal("        📁 Work", options[2].DisplayName);
        Assert.Equal("My Drive > Documents > Work", options[2].FullPath);

        Assert.Equal("inv", options[3].Id);
        Assert.Equal(3, options[3].Level);
        Assert.Equal("work", options[3].ParentId);
        Assert.Equal("            📁 Invoices", options[3].DisplayName);
        Assert.Equal("My Drive > Documents > Work > Invoices", options[3].FullPath);

        Assert.Equal("pic", options[4].Id);
        Assert.Equal(1, options[4].Level);
        Assert.Equal("    📁 Pictures", options[4].DisplayName);
        Assert.Equal("My Drive > Pictures", options[4].FullPath);
    }

    [Fact]
    public void BuildFlattenedFolderList_BrokenParentId_HandledAsRootLevelChild()
    {
        var folders = new List<FolderModelDummy>
        {
            new FolderModelDummy { Id = "orphan", Name = "OrphanFolder", ParentId = "missing-parent-id" },
        };

        var options = FolderPickerOptionTester.BuildFlattenedFolderList(folders);

        Assert.Equal(2, options.Count);
        Assert.Equal("orphan", options[1].Id);
        Assert.Equal(1, options[1].Level);
        Assert.Equal("    📁 OrphanFolder", options[1].DisplayName);
        Assert.Equal("My Drive > OrphanFolder", options[1].FullPath);
    }

    [Fact]
    public void BuildFlattenedFolderList_CyclicReferences_TerminatesWithoutCrash()
    {
        var folders = new List<FolderModelDummy>
        {
            new FolderModelDummy { Id = "loopA", Name = "LoopA", ParentId = "loopB" },
            new FolderModelDummy { Id = "loopB", Name = "LoopB", ParentId = "loopA" },
        };

        var options = FolderPickerOptionTester.BuildFlattenedFolderList(folders);

        Assert.True(options.Count >= 1);
        Assert.Equal(0, options[0].Level);
    }
}
