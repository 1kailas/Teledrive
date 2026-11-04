using System;
using System.Text.Json;
using Xunit;

namespace TeleDrive.Tests;

public class AppConfigModel
{
    public int CardSizeTier { get; set; } = 3;
    public double TargetTileWidth { get; set; } = 205;
    public int ViewMode { get; set; } = 0;
    public string Theme { get; set; } = "Default";
    public bool IsPaneOpen { get; set; } = true;
    public bool IsDetailsPaneVisible { get; set; } = true;
    public int WindowX { get; set; } = -1;
    public int WindowY { get; set; } = -1;
    public int WindowWidth { get; set; } = 1280;
    public int WindowHeight { get; set; } = 820;
    public bool IsMaximized { get; set; } = false;

    public static int GetTierFromWidth(double width)
    {
        if (width <= 110) return 0;
        if (width <= 145) return 1;
        if (width <= 185) return 2;
        if (width <= 235) return 3;
        return 4;
    }

    public static int ClampTier(int tier) => Math.Clamp(tier, 0, 4);
}

public class AppConfigTests
{
    [Fact]
    public void AppConfig_DefaultValues_AreProductionReady()
    {
        var cfg = new AppConfigModel();
        Assert.Equal(3, cfg.CardSizeTier);
        Assert.Equal(205.0, cfg.TargetTileWidth);
        Assert.Equal(0, cfg.ViewMode);
        Assert.Equal("Default", cfg.Theme);
        Assert.True(cfg.IsPaneOpen);
        Assert.True(cfg.IsDetailsPaneVisible);
        Assert.Equal(1280, cfg.WindowWidth);
        Assert.Equal(820, cfg.WindowHeight);
        Assert.False(cfg.IsMaximized);
    }

    [Theory]
    [InlineData(96, 0)]
    [InlineData(110, 0)]
    [InlineData(130, 1)]
    [InlineData(145, 1)]
    [InlineData(165, 2)]
    [InlineData(185, 2)]
    [InlineData(205, 3)]
    [InlineData(235, 3)]
    [InlineData(265, 4)]
    public void GetTierFromWidth_MapsCorrectlyAcrossAllScaleTiers(double width, int expectedTier)
    {
        int tier = AppConfigModel.GetTierFromWidth(width);
        Assert.Equal(expectedTier, tier);
    }

    [Theory]
    [InlineData(-5, 0)]
    [InlineData(0, 0)]
    [InlineData(2, 2)]
    [InlineData(4, 4)]
    [InlineData(10, 4)]
    public void ClampTier_EnsuresSafeRange(int input, int expected)
    {
        Assert.Equal(expected, AppConfigModel.ClampTier(input));
    }

    [Fact]
    public void AppConfig_JsonSerializationRoundTrip_PreservesAllProperties()
    {
        var original = new AppConfigModel
        {
            CardSizeTier = 2,
            TargetTileWidth = 165,
            ViewMode = 1,
            Theme = "Dark",
            IsPaneOpen = false,
            IsDetailsPaneVisible = false,
            WindowX = 150,
            WindowY = 200,
            WindowWidth = 1440,
            WindowHeight = 900,
            IsMaximized = true
        };

        var json = JsonSerializer.Serialize(original, new JsonSerializerOptions { WriteIndented = true });
        var restored = JsonSerializer.Deserialize<AppConfigModel>(json);

        Assert.NotNull(restored);
        Assert.Equal(original.CardSizeTier, restored!.CardSizeTier);
        Assert.Equal(original.TargetTileWidth, restored.TargetTileWidth);
        Assert.Equal(original.ViewMode, restored.ViewMode);
        Assert.Equal(original.Theme, restored.Theme);
        Assert.Equal(original.IsPaneOpen, restored.IsPaneOpen);
        Assert.Equal(original.IsDetailsPaneVisible, restored.IsDetailsPaneVisible);
        Assert.Equal(original.WindowX, restored.WindowX);
        Assert.Equal(original.WindowY, restored.WindowY);
        Assert.Equal(original.WindowWidth, restored.WindowWidth);
        Assert.Equal(original.WindowHeight, restored.WindowHeight);
        Assert.Equal(original.IsMaximized, restored.IsMaximized);
    }
}
