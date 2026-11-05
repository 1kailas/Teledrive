using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace TeleDrive.Tests;

public static class FileConflictHelper
{
    public static (List<string> NonConflicting, List<string> Conflicting) PartitionUploads(
        IEnumerable<string> filePaths,
        IEnumerable<string> existingFileNames)
    {
        var existingSet = new HashSet<string>(existingFileNames, StringComparer.OrdinalIgnoreCase);
        var nonConflicting = new List<string>();
        var conflicting = new List<string>();

        foreach (var path in filePaths)
        {
            var name = Path.GetFileName(path.Replace('\\', '/'));
            if (existingSet.Contains(name))
            {
                conflicting.Add(path);
            }
            else
            {
                nonConflicting.Add(path);
            }
        }

        return (nonConflicting, conflicting);
    }

    public static string GenerateUniqueFileName(string fileName, HashSet<string> takenNames)
    {
        if (!takenNames.Contains(fileName)) return fileName;

        var ext = Path.GetExtension(fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);

        for (int i = 1; i < 10000; i++)
        {
            var candidate = $"{stem} ({i}){ext}";
            if (!takenNames.Contains(candidate))
            {
                return candidate;
            }
        }

        return $"{stem}_{Guid.NewGuid()}{ext}";
    }
}

public class FileConflictTests
{
    [Fact]
    public void PartitionUploads_SeparatesConflictingAndNonConflicting_CaseInsensitive()
    {
        var existing = new[] { "Report.pdf", "Photo.JPG", "notes.txt" };
        var incoming = new[]
        {
            @"C:\Users\User\Downloads\report.PDF", // Conflict (different casing)
            @"C:\Users\User\Downloads\NewDoc.docx", // No conflict
            @"C:\Users\User\Downloads\PHOTO.jpg",  // Conflict
            @"C:\Users\User\Downloads\data.csv"    // No conflict
        };

        var (nonConflicting, conflicting) = FileConflictHelper.PartitionUploads(incoming, existing);

        Assert.Equal(2, conflicting.Count);
        Assert.Contains(incoming[0], conflicting);
        Assert.Contains(incoming[2], conflicting);

        Assert.Equal(2, nonConflicting.Count);
        Assert.Contains(incoming[1], nonConflicting);
        Assert.Contains(incoming[3], nonConflicting);
    }

    [Fact]
    public void GenerateUniqueFileName_IncrementsSuffixCorrectly()
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Document.pdf",
            "Document (1).pdf",
            "Document (2).pdf"
        };

        var unique = FileConflictHelper.GenerateUniqueFileName("Document.pdf", taken);
        Assert.Equal("Document (3).pdf", unique);
    }

    [Fact]
    public void GenerateUniqueFileName_KeepsOriginalWhenNotTaken()
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Other.txt" };
        var unique = FileConflictHelper.GenerateUniqueFileName("Document.pdf", taken);
        Assert.Equal("Document.pdf", unique);
    }
}
